const express = require("express");
const path = require("path");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const multer = require("multer");
const { getMidtransApiBaseForNewTransaction, getMidtransApiBaseForOrder, getMidtransServerKeyForNewTransaction, getMidtransServerKeyForOrder, getMidtransModeInfo } = require("./midtrans-config");
const { normalizeStorageObjectPath } = require("./storage-path");
const { csvCell } = require("./csv-safe");
const { isValidNewResidentPassword } = require("./password-policy");
const { createRateLimitKey } = require("./rate-limit-key");
const { detectImageType } = require("./image-validation");
const { createSignedSessionToken, verifySignedSessionToken } = require("./session-security");
const { isValidIuranMonth } = require("./iuran-validation");
const { isValidMidtransSignature, isSuccessfulMidtransStatus } = require("./midtrans-webhook-security");
const { findConflictingSettledRows } = require("./midtrans-order-reconciliation");
const { canAccessOwnedRecord } = require("./access-control");
const { cancelPendingMidtransTransaction } = require("./midtrans-cancel");

const { buatTemplateRab, buatRencanaKerja, normalisasiRabAspirasi, infoKategoriAspirasi } = require("./aspirasi-rab");
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Jangan biarkan browser/PWA menahan HTML dashboard versi lama.
  if (req.path === "/" || req.path === "/index.html" || req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }

  next();
});
app.use(express.json({ limit: "256kb" }));

/* MIDTRANS QRIS: endpoint dipilih sesuai mode dan asal order. */
async function buatTransaksiQRIS({ orderId, total, namaWarga, namaPembayar }) {
  const serverKey = getMidtransServerKeyForNewTransaction();

  if (!serverKey) {
    throw new Error("Kunci Midtrans untuk mode yang aktif belum diatur di Vercel.");
  }

  const auth = Buffer.from(`${serverKey}:`).toString("base64");

  const response = await fetch(
    `${getMidtransApiBaseForNewTransaction()}/v2/charge`,
    {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Override-Notification": "https://rt-kita-tbk.vercel.app/api/midtrans/webhook"
      },
      // Batasi waktu tunggu gateway agar proses pembuatan QRIS tidak menggantung.
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        payment_type: "qris",
        transaction_details: {
          order_id: orderId,
          gross_amount: total
        },
        customer_details: {
          first_name: namaPembayar || namaWarga || "Warga RT TBK"
        },
        qris: {
          acquirer: "gopay"
        }
      })
    }
  );

  const hasil = await response.json();

  if (!response.ok) {
    console.error("MIDTRANS QRIS ERROR:", hasil);
    throw new Error("Transaksi QRIS gagal dibuat. Periksa mode dan kredensial Midtrans.");
  }

  return hasil;
}


/* WEBHOOK MIDTRANS QRIS */
app.post("/api/midtrans/webhook", async (req, res) => {
  try {
const {
  order_id,
  status_code,
  gross_amount,
  signature_key,
  transaction_status,
  fraud_status,
  transaction_id,
  transaction_time,
  settlement_time
} = req.body || {};


    const serverKey = getMidtransServerKeyForOrder(order_id);

    if (!serverKey || !order_id || !signature_key) {
      return res.status(400).json({
        ok: false,
        message: "Data notifikasi tidak lengkap."
      });
    }

    if (!isValidMidtransSignature({
      orderId: order_id,
      statusCode: status_code,
      grossAmount: gross_amount,
      signatureKey: signature_key,
      serverKey
    })) {
      return res.status(403).json({
        ok: false,
        message: "Tanda tangan Midtrans tidak valid."
      });
    }


    const berhasil = isSuccessfulMidtransStatus(transaction_status, fraud_status);

    const dibatalkan =
      transaction_status === "expire" ||
      transaction_status === "cancel" ||
      transaction_status === "deny";

    if (dibatalkan) {
      console.log("TRANSAKSI QRIS TIDAK BERHASIL:", {
        order_id,
        transaction_status
      });

      return res.status(200).json({
        ok: true,
        message: "Transaksi tidak berhasil. Riwayat iuran tetap tersimpan."
      });
    }

    if (!berhasil) {
      return res.status(200).json({
        ok: true,
        message: "Status transaksi diterima, belum perlu pelunasan."
      });
    }


    const dataIuran = await supabaseRequest("iuran_warga", {
      query:
        "select=id,warga_id,keluarga_id,bulan,status,total_amount,bukti_transfer,midtrans_notifikasi_at,midtrans_transaction_id,jalur_pembayaran,disetorkan_oleh_nama" +
        `&bukti_transfer=eq.${encodeURIComponent("MIDTRANS:" + order_id)}`
    });

    let rows = Array.isArray(dataIuran) ? dataIuran : [];

    // A replacement QRIS order can be reserved after Midtrans reports the
    // previous order expired. Keep an immutable order-to-row ledger so a
    // late settlement webhook for that previous order can still be reconciled.
    if (!rows.length) {
      const dataOrder = await supabaseRequest("iuran_midtrans_orders", {
        query:
          "select=order_id,row_ids,total_amount" +
          `&order_id=eq.${encodeURIComponent(order_id)}` +
          "&limit=1"
      });
      const orderTercatat = Array.isArray(dataOrder) ? dataOrder[0] : null;
      const rowIds = Array.isArray(orderTercatat?.row_ids)
        ? [...new Set(orderTercatat.row_ids.map(Number))]
        : [];

      if (
        !orderTercatat ||
        !rowIds.length ||
        rowIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        Number(orderTercatat.total_amount) !== Number(gross_amount)
      ) {
        console.error("IURAN UNTUK ORDER MIDTRANS TIDAK DITEMUKAN:", order_id);
        return res.status(500).json({
          ok: false,
          message: "Catatan iuran belum ditemukan. Silakan coba kembali."
        });
      }

      const dataRiwayat = await supabaseRequest("iuran_warga", {
        query:
          "select=id,warga_id,keluarga_id,bulan,status,total_amount,bukti_transfer,midtrans_notifikasi_at,midtrans_transaction_id,jalur_pembayaran,disetorkan_oleh_nama" +
          `&id=in.(${rowIds.join(",")})`
      });
      rows = Array.isArray(dataRiwayat) ? dataRiwayat : [];

      if (
        rows.length !== rowIds.length ||
        rows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0) !== Number(gross_amount)
      ) {
        console.error("REKONSILIASI ORDER LAMA TIDAK LENGKAP:", {
          order_id,
          expectedRows: rowIds.length,
          actualRows: rows.length
        });
        return res.status(500).json({
          ok: false,
          message: "Rekonsiliasi pembayaran perlu pemeriksaan Ketua RT."
        });
      }

      console.warn("MIDTRANS LATE SETTLEMENT RECONCILED FROM ORDER LEDGER:", order_id);
    }

    // A late settlement for an old order can legitimately pay rows now linked
    // to a replacement order. If those rows were already settled by a DIFFERENT
    // order, do not overwrite their transaction metadata or silently treat the
    // second charge as an ordinary duplicate webhook. Flag it for manual refund
    // reconciliation; never issue an automatic refund from a notification hook.
    const konflikPembayaran = findConflictingSettledRows(rows, order_id, transaction_id);
    if (konflikPembayaran.length) {
      console.error("DUPLICATE MIDTRANS SETTLEMENT REQUIRES MANUAL REFUND REVIEW:", {
        order_id,
        transaction_id,
        row_ids: konflikPembayaran.map(row => row.id),
        existing_orders: [...new Set(konflikPembayaran.map(row => row.bukti_transfer))]
      });

      // Persist an admin-visible alert so a duplicate charge is not left only
      // in ephemeral server logs. Deduplicate per affected iuran row on retries.
      try {
        for (const row of konflikPembayaran) {
          const notifAda = await supabaseRequest("notifikasi", {
            query:
              "select=id" +
              "&penerima_peran=eq.admin" +
              "&jenis=eq.iuran" +
              "&judul=eq.Pembayaran%20QRIS%20Ganda" +
              `&referensi_id=eq.${encodeURIComponent(row.id)}` +
              "&limit=1"
          });

          if (!Array.isArray(notifAda) || notifAda.length === 0) {
            await supabaseRequest("notifikasi", {
              method: "POST",
              body: {
                penerima_peran: "admin",
                judul: "Pembayaran QRIS Ganda",
                pesan:
                  `Terdeteksi pembayaran QRIS kedua untuk iuran ${row.bulan || row.id}. ` +
                  `Order: ${order_id}; transaksi: ${transaction_id || "tidak tersedia"}. ` +
                  "Catatan iuran tidak diubah. Periksa transaksi Midtrans dan lakukan pengembalian dana manual bila terkonfirmasi.",
                jenis: "iuran",
                tautan: "/admin",
                referensi_id: Number(row.id),
                sudah_dibaca: false
              }
            });
          }
        }
      } catch (notifError) {
        console.error("GAGAL MENYIMPAN NOTIFIKASI PEMBAYARAN QRIS GANDA:", notifError?.message || notifError);
      }

      return res.status(200).json({
        ok: true,
        code: "DUPLICATE_SETTLEMENT_REQUIRES_REFUND_REVIEW",
        message: "Pembayaran kedua terdeteksi. Catatan iuran tidak diubah; perlu pemeriksaan dan pengembalian dana manual."
      });
    }

    const totalCatatan = rows.reduce(
      (sum, row) => sum + Number(row.total_amount || 0),
      0
    );

    if (totalCatatan !== Number(gross_amount)) {
      console.error("TOTAL MIDTRANS TIDAK COCOK:", {
        order_id,
        gross_amount,
        totalCatatan
      });

      return res.status(400).json({
        ok: false,
        message: "Total transaksi tidak cocok."
      });
    }

   
for (const iuran of rows) {
  const sudahLunas = iuran.status === "lunas";

 
  // Simpan waktu notifikasi hanya jika belum pernah tercatat.
  const dataBukti = {};

  if (!iuran.midtrans_notifikasi_at) {
    dataBukti.midtrans_notifikasi_at = new Date().toISOString();
  }


  if (transaction_id) {
    dataBukti.midtrans_transaction_id = transaction_id;
  }

  if (transaction_status) {
    dataBukti.midtrans_status = transaction_status;
  }

  if (settlement_time) {
    const waktuSettlement = String(settlement_time).trim();
    const tanggalSettlement = new Date(
      /(?:Z|[+-]\d{2}:\d{2})$/.test(waktuSettlement)
        ? waktuSettlement
        : waktuSettlement.replace(" ", "T") + "+07:00"
    );

    if (!Number.isNaN(tanggalSettlement.getTime())) {
      dataBukti.midtrans_settlement_at =
        tanggalSettlement.toISOString();
    }
  }

  await supabaseRequest("iuran_warga", {
    method: "PATCH",
    query: `id=eq.${encodeURIComponent(iuran.id)}`,
    body: dataBukti
  });

  // Jika sudah lunas, jangan membuat kas atau notifikasi kedua kali.
  if (sudahLunas) continue;

  const bulan = String(iuran.bulan).slice(0, 7);

      const kategoriKas = [
        {
          kategori: "Sampah",
          jumlah: 15000,
          keterangan: `Sampah dari iuran ${iuran.bulan} - iuran_id ${iuran.id}${iuran.jalur_pembayaran === "ketua_gang_qris" && iuran.disetorkan_oleh_nama ? " - disetorkan oleh " + iuran.disetorkan_oleh_nama : ""}`
        },
        {
          kategori: "Keamanan",
          jumlah: 15000,
          keterangan: `Keamanan dari iuran ${iuran.bulan} - iuran_id ${iuran.id}${iuran.jalur_pembayaran === "ketua_gang_qris" && iuran.disetorkan_oleh_nama ? " - disetorkan oleh " + iuran.disetorkan_oleh_nama : ""}`
        },
        {
          kategori: "Kas RT",
          jumlah: 5000,
          keterangan: `Kas RT dari iuran ${iuran.bulan} - iuran_id ${iuran.id}${iuran.jalur_pembayaran === "ketua_gang_qris" && iuran.disetorkan_oleh_nama ? " - disetorkan oleh " + iuran.disetorkan_oleh_nama : ""}`
        }
      ];

      for (const kas of kategoriKas) {
        const ada = await supabaseRequest("kas_rt", {
          query:
            "select=id" +
            `&keterangan=eq.${encodeURIComponent(kas.keterangan)}` +
            "&limit=1"
        });

        if (!Array.isArray(ada) || !ada.length) {
          try {
            await supabaseRequest("kas_rt", {
              method: "POST",
              body: {
                tanggal: new Date().toISOString().slice(0, 10),
                jenis: "masuk",
                kategori: kas.kategori,
                jumlah: kas.jumlah,
                keterangan: kas.keterangan
              }
            });
          } catch (insertError) {
            // A unique database index will make concurrent duplicate webhook
            // deliveries harmless. Ignore only the expected duplicate-key error.
            if (getSupabaseErrorCode(insertError) !== "23505") {
              throw insertError;
            }
          }
        }
      }

    
const waktuMidtrans = settlement_time || transaction_time;
let dibayarAt = null;

if (waktuMidtrans) {
  // Waktu dari notifikasi Midtrans menggunakan WIB (GMT+7).
  const waktuISO = waktuMidtrans.includes("T")
    ? waktuMidtrans
    : waktuMidtrans.replace(" ", "T") + "+07:00";

  const tanggalPembayaran = new Date(waktuISO);

  if (!Number.isNaN(tanggalPembayaran.getTime())) {
    dibayarAt = tanggalPembayaran.toISOString();
  }
}


const dataUpdate = {
  status: "lunas",
  diverifikasi_at: new Date().toISOString(),
  diverifikasi_oleh: "Midtrans QRIS"
};

// Jangan mengarang waktu pembayaran jika Midtrans tidak mengirimkannya.
if (dibayarAt) {
  dataUpdate.dibayar_at = dibayarAt;
}

// Simpan ID transaksi dan status resmi dari Midtrans.
if (transaction_id) {
  dataUpdate.midtrans_transaction_id = transaction_id;
}

if (transaction_status) {
  dataUpdate.midtrans_status = transaction_status;
}

// Waktu Midtrans menggunakan WIB jika tidak mencantumkan zona waktu.
if (settlement_time) {
  const waktuSettlement = String(settlement_time).trim();
  const waktuISO = new Date(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(waktuSettlement)
      ? waktuSettlement
      : waktuSettlement.replace(" ", "T") + "+07:00"
  );

  if (!Number.isNaN(waktuISO.getTime())) {
    dataUpdate.midtrans_settlement_at = waktuISO.toISOString();
  }
}

const hasilUpdate = await supabaseRequest("iuran_warga", {
  method: "PATCH",
  query:
    `id=eq.${encodeURIComponent(iuran.id)}` +
    "&status=neq.lunas",
  body: dataUpdate
});

// Hanya proses notifikasi jika callback ini yang pertama kali melunasi baris.
const barisDiperbarui = Array.isArray(hasilUpdate)
  ? hasilUpdate[0]
  : hasilUpdate;
if (!barisDiperbarui || barisDiperbarui.status !== "lunas") {
  continue;
}

      try {
        await supabaseRequest("notifikasi", {
          method: "POST",
          body: {
            penerima_peran: "warga",
            penerima_warga_id: iuran.warga_id,
            judul: "Pembayaran Iuran Berhasil",
            pesan: `Iuran bulan ${bulan} telah lunas melalui QRIS.`,
            jenis: "iuran",
            tautan: "/",
            referensi_id: iuran.id,
            sudah_dibaca: false
          }
        });
      } catch (notifError) {
        console.error(
          "NOTIFIKASI QRIS ERROR:",
          notifError?.message || notifError
        );
      }
    }

    return res.status(200).json({
      ok: true,
      message: "Pembayaran QRIS berhasil diproses."
    });
  } catch (error) {
    console.error("MIDTRANS WEBHOOK ERROR:", error?.message || error);

    return res.status(500).json({
      ok: false,
      message: "Gagal memproses notifikasi pembayaran."
    });
  }
});


app.use(express.urlencoded({ extended: true, limit: "256kb", parameterLimit: 200 }));
const uploadFoto = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 2,
    fields: 10,
    parts: 12,
    fieldNameSize: 100,
    fieldSize: 2048,
    fieldNestingDepth: 1,
    fieldArrayIndexLimit: 1
  },
  fileFilter: (req, file, cb) => {
    const tipeDiizinkan = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (tipeDiizinkan.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Foto harus berformat JPG, PNG, atau WebP."));
    }
  }
});






const uploadDokumenIdentitas = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 21, fields: 8, parts: 30 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    cb(allowed.includes(file.mimetype) ? null : new Error("Dokumen harus JPG, PNG, WebP, atau PDF."), allowed.includes(file.mimetype));
  }
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = crypto
    .scryptSync(password, salt, 64)
    .toString("hex");

  return `${salt}:${hash}`;
}

function constantTimeStringEqual(value, expected) {
  if (typeof value !== "string" || typeof expected !== "string") {
    return false;
  }

  const valueHash = crypto.createHash("sha256").update(value).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();

  return crypto.timingSafeEqual(valueHash, expectedHash);
}

function dataWargaAman(warga) {
  if (!warga || typeof warga !== "object" || Array.isArray(warga)) {
    return warga;
  }

  const salinan = { ...warga };
  delete salinan.password;
  return salinan;
}

function verifyPassword(password, storedPassword) {
  if (
    typeof password !== "string" ||
    password.length > 1024 ||
    typeof storedPassword !== "string"
  ) {
    return false;
  }

  const parts = storedPassword.split(":");
  if (parts.length !== 2) return false;

  const [salt, storedHash] = parts;

  // Hashes created by hashPassword use a 16-byte salt and a 64-byte scrypt hash.
  // Reject malformed database values instead of letting timingSafeEqual throw.
  if (
    !/^[a-f0-9]{32}$/i.test(salt) ||
    !/^[a-f0-9]{128}$/i.test(storedHash)
  ) {
    return false;
  }

  const expectedHash = Buffer.from(storedHash, "hex");
  const actualHash = crypto.scryptSync(password, salt, 64);

  if (actualHash.length !== expectedHash.length) return false;

  return crypto.timingSafeEqual(actualHash, expectedHash);
}

const sessions = new Map();

async function supabaseRequest(table, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Supabase belum terhubung");
  }

  const method = options.method || "GET";
  const query = options.query || "";
  const body = options.body;

  const url =
    `${SUPABASE_URL}/rest/v1/${table}` +
    (query ? `?${query}` : "");

  const response = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error("SUPABASE ERROR:", response.status, data);
    throw new Error(
      typeof data === "object"
        ? JSON.stringify(data)
        : String(data)
    );
  }

  return data;
}
function getSupabaseErrorCode(error) {
  try {
    const message = String(error?.message || "");
    const parsed = JSON.parse(message);
    return parsed?.code || null;
  } catch {
    return error?.code || null;
  }
}

async function buatUrlFotoPrivat(objectPath) {
  if (!objectPath) return null;

  try {
    const bucket = "foto warga";
    const normalizedPath = normalizeStorageObjectPath(objectPath, bucket);
    if (!normalizedPath) return null;

    const encodedPath = normalizedPath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    const response = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodedPath}`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ expiresIn: 3600 })
      }
    );

    if (!response.ok) {
      console.error("SIGNED FOTO ERROR:", await response.text());
      return null;
    }

    const data = await response.json();
    const signedURL = data.signedURL;

    if (!signedURL) return null;

    return signedURL.startsWith("http")
      ? signedURL
      : `${SUPABASE_URL}/storage/v1${signedURL.startsWith("/") ? "" : "/"}${signedURL}`;
  } catch (error) {
    console.error("BUAT URL FOTO ERROR:", error);
    return null;
  }
}


function hashBuktiPengeluaran(fileBuffer) {
  return crypto
    .createHash("sha256")
    .update(fileBuffer)
    .digest("hex");
}

async function uploadBuktiPengeluaran(fileName, fileBuffer, contentType) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Supabase belum terhubung");
  }

  const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${Date.now()}-${safeName}`;
  const url =
    `${SUPABASE_URL}/storage/v1/object/bukti-pengeluaran/${path}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": contentType,
      "x-upsert": "false"
    },
    body: fileBuffer
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("UPLOAD BUKTI ERROR:", response.status, detail);
    throw new Error("Gagal mengunggah bukti pengeluaran");
  }

  return path;
}



function getToken(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)rt_token=([^;]+)/);

  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function createSessionToken(session) {
  return createSignedSessionToken(session, process.env.SESSION_SECRET);
}

function getSession(req) {
  return verifySignedSessionToken(
    getToken(req),
    process.env.SESSION_SECRET
  );
}


function requireLogin(req, res, next) {
  const session = getSession(req);

  if (!session) {
    return res.status(401).json({
      ok: false,
      message: "Belum login"
    });
  }

  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session || session.role !== "admin") return res.status(403).json({ ok: false, message: "Akses khusus Ketua RT" });
  req.session = session; next();
}
function requireStaff(roles = []) {
  return async (req, res, next) => {
    const session = getSession(req);
    if (!session || !roles.includes(session.role)) {
      return res.status(403).json({ ok: false, message: "Akses tidak diizinkan untuk jabatan ini" });
    }
    if (session.role !== "admin") {
      try {
        const id = String(session.id || "");
        if (!/^\d+$/.test(id)) {
          return res.status(403).json({ ok: false, message: "Identitas akun petugas tidak valid" });
        }
        const rows = await supabaseRequest("petugas_rt", {
          query: "select=id,role,status,gang,nama_lengkap,warga_id&id=eq." + encodeURIComponent(id) + "&limit=1"
        });
        const staff = Array.isArray(rows) ? rows[0] : null;
        if (!staff || staff.status !== "aktif" || staff.role !== session.role) {
          return res.status(403).json({ ok: false, message: "Akun petugas sudah dinonaktifkan atau hak aksesnya berubah. Silakan login kembali." });
        }
        if (session.role === "sekretaris" && !staff.warga_id) {
          return res.status(403).json({ ok: false, message: "Akun Sekretaris belum terhubung ke data warga yang sah." });
        }
        session.gang = staff.gang || "";
        session.wargaId = staff.warga_id || null;
        session.nama = staff.nama_lengkap || session.nama || "";
      } catch (error) {
        console.error("STAFF AUTH CHECK ERROR:", error?.message || error);
        return res.status(503).json({ ok: false, message: "Pemeriksaan akses petugas sementara tidak tersedia." });
      }
    }
    req.session = session;
    next();
  };
}
const requireFinance = requireStaff(["admin", "bendahara"]);
const requireSecretary = requireStaff(["admin", "sekretaris"]);
const requireGangLead = requireStaff(["admin", "ketua_gang"]);



async function requireWarga(req, res, next) {
  const session = getSession(req);

  if (!session || session.role !== "warga") {
    return res.status(403).json({
      ok: false,
      message: "Akses khusus warga"
    });
  }

  try {
    const data = await supabaseRequest("warga", {
      query:
        `select=id,status_warga` +
        `&id=eq.${encodeURIComponent(session.wargaId)}` +
        `&limit=1`
    });

    if (!Array.isArray(data) || !data.length) {
      return res.status(403).json({
        ok: false,
        message: "Akun warga tidak ditemukan"
      });
    }

    if (data[0].status_warga !== "aktif") {
      res.setHeader(
        "Set-Cookie",
        "rt_token=; Path=/; HttpOnly; Secure; Max-Age=0; SameSite=Lax"
      );

      return res.status(403).json({
        ok: false,
        message: "Akun Anda sudah tidak aktif. Silakan hubungi Ketua RT."
      });
    }

    req.session = session;
    next();
  } catch (error) {
    console.error("CEK STATUS WARGA ERROR:", error);

    return res.status(503).json({
      ok: false,
      message: "Status akun belum dapat diperiksa. Silakan coba lagi."
    });
  }
}


/* INFO PEMBAYAR IURAN UNTUK TRANSAKSI KAS */
const NAMA_BULAN_ID = [
  "Januari","Februari","Maret","April","Mei","Juni",
  "Juli","Agustus","September","Oktober","November","Desember"
];

function labelBulanIuran(bulan) {
  const m = String(bulan || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return String(bulan || "");
  return `${NAMA_BULAN_ID[Number(m[2]) - 1] || m[2]} ${m[1]}`;
}

async function ambilNamaWarga(ids) {
  const bersih = [...new Set(
    ids.map(id => String(id ?? "").trim()).filter(id => /^[0-9]+$/.test(id))
  )];
  const peta = new Map();
  if (!bersih.length) return peta;

  const data = await supabaseRequest("warga", {
    query: `select=id,nama_lengkap,nik,alamat,no_hp&id=in.(${bersih.join(",")})`
  });

  (Array.isArray(data) ? data : []).forEach(w => peta.set(String(w.id), w));
  return peta;
}

async function infoIuranUntukKas(rows) {
  const peta = new Map();
  const ids = [...new Set(
    rows
      .map(r => (String(r.keterangan || "").match(/iuran_id\s+(\d+)/i) || [])[1])
      .filter(Boolean)
  )];
  if (!ids.length) return peta;

  try {
    const iuran = await supabaseRequest("iuran_warga", {
      query:
        "select=id,warga_id,bulan,total_amount,status,diverifikasi_at,diverifikasi_oleh" +
        `&id=in.(${ids.join(",")})`
    });
    const daftar = Array.isArray(iuran) ? iuran : [];
    const warga = await ambilNamaWarga(daftar.map(i => i.warga_id));

    daftar.forEach(i => {
      peta.set(String(i.id), {
        ...i,
        nama_warga: warga.get(String(i.warga_id))?.nama_lengkap || "",
        periode_label: labelBulanIuran(i.bulan)
      });
    });
  } catch (error) {
    console.error("INFO IURAN KAS ERROR:", error?.message || error);
  }

  return peta;
}

function iuranIdDariKeterangan(keterangan) {
  return (String(keterangan || "").match(/iuran_id\s+(\d+)/i) || [])[1] || "";
}

function keteranganKasRapi(row, info) {
  if (!info) return row.keterangan || "";
  const kategori = row.kategori || "Iuran";
  return `Iuran ${kategori} ${info.periode_label} - dari ${info.nama_warga || "warga"}`;
}

/* PENDAFTARAN MANDIRI WARGA: tidak mensyaratkan data KK/KTP diinput Ketua RT terlebih dahulu. */
app.post("/api/register-warga", async (req, res) => {
  try {
    const nama_lengkap = String(req.body?.nama_lengkap || req.body?.nama || req.body?.nama_warga || "").trim().replace(/\s+/g, " ").slice(0,120);
    const session = getSession(req);
    const didaftarkanKetuaRT = session?.role === "admin";
    const nik = String(req.body?.nik || "").replace(/\D/g, "");
    const alamat = String(req.body?.alamat || "").trim().slice(0,300);
    const no_hp = String(req.body?.no_hp || "").trim().replace(/[\s-]/g, "");
    const password = req.body?.password;

    if (nama_lengkap.length < 3) {
      console.warn("REGISTER NAME VALIDATION:", {bodyKeys:Object.keys(req.body || {}), nameLength:nama_lengkap.length, admin:didaftarkanKetuaRT});
      return res.status(400).json({ok:false,message:"Nama lengkap belum terbaca. Ketik nama lengkap minimal 3 karakter pada kolom Nama lengkap sesuai KTP."});
    }
    if (!/^\d{16}$/.test(nik)) {
      return res.status(400).json({ok:false,message:"NIK harus terdiri dari 16 digit sesuai KTP."});
    }
    if (!/^\+?\d{9,18}$/.test(no_hp)) {
      return res.status(400).json({ok:false,message:"Nomor HP tidak valid. Gunakan nomor HP aktif."});
    }
    if (!isValidNewResidentPassword(password)) {
      return res.status(400).json({ok:false,message:"Password minimal 8 karakter."});
    }

    const sessionSecret = process.env.SESSION_SECRET;
    if (typeof sessionSecret !== "string" || Buffer.byteLength(sessionSecret, "utf8") < 32) {
      console.error("REGISTER CONFIG ERROR: SESSION_SECRET is missing or too short");
      return res.status(503).json({ok:false,message:"Layanan pendaftaran sedang tidak siap. Silakan coba kembali nanti."});
    }

    const registrationRateLimitKey = createRateLimitKey(sessionSecret, "register", no_hp);
    const registrationRateLimitRows = await supabaseRequest("rpc/consume_login_rate_limit", {
      method:"POST",
      body:{p_key_hash:registrationRateLimitKey,p_window_seconds:900,p_max_attempts:5}
    });
    const registrationRateLimit = Array.isArray(registrationRateLimitRows) ? registrationRateLimitRows[0] : registrationRateLimitRows;
    if (!registrationRateLimit || typeof registrationRateLimit.allowed !== "boolean") {
      throw new Error("Respons pembatasan pendaftaran tidak valid");
    }
    if (!registrationRateLimit.allowed) {
      const retryAfter = Math.max(1, Number(registrationRateLimit.retry_after_seconds) || 900);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ok:false,message:"Terlalu banyak percobaan pendaftaran. Silakan coba lagi beberapa menit kemudian."});
    }

    const phoneRows = await supabaseRequest("warga", {
      query:"select=id&no_hp=eq." + encodeURIComponent(no_hp) + "&limit=1"
    });
    if (Array.isArray(phoneRows) && phoneRows.length) {
      return res.status(409).json({ok:false,message:"Nomor HP sudah digunakan oleh akun warga lain."});
    }

    const identityRows = await supabaseRequest("warga", {
      query:"select=id,nama_lengkap,nik,no_hp,status_warga&nik=eq." + encodeURIComponent(nik) + "&limit=2"
    });
    if (Array.isArray(identityRows) && identityRows.length > 1) {
      return res.status(409).json({ok:false,message:"NIK tercatat lebih dari satu kali. Hubungi Ketua RT untuk pemeriksaan."});
    }

    const existing = Array.isArray(identityRows) ? identityRows[0] : null;
    let saved;
    if (existing) {
      if (existing.no_hp) {
        return res.status(409).json({ok:false,message:"NIK ini sudah memiliki akun. Silakan login atau hubungi Ketua RT jika lupa akses."});
      }
      const updatedRows = await supabaseRequest("warga", {
        method:"PATCH",
        query:"id=eq." + encodeURIComponent(String(existing.id)),
        body:{
          nama_lengkap: existing.nama_lengkap || nama_lengkap,
          alamat: alamat || undefined,
          no_hp,
          password:hashPassword(password),
          status_warga:didaftarkanKetuaRT ? "aktif" : "menunggu_verifikasi"
        }
      });
      saved = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;
    } else {
      const insertedRows = await supabaseRequest("warga", {
        method:"POST",
        body:{
          nama_lengkap,
          nik,
          alamat: alamat || null,
          no_hp,
          password:hashPassword(password),
          status_warga:didaftarkanKetuaRT ? "aktif" : "menunggu_verifikasi"
        }
      });
      saved = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;
    }

    if (!saved || !saved.id) {
      throw new Error("Pembuatan akun warga tidak dikonfirmasi oleh database");
    }

    return res.status(201).json({
      ok:true,
      message:didaftarkanKetuaRT ? "Akun warga berhasil dibuat dan diaktifkan oleh Ketua RT." : "Pendaftaran berhasil. Akun menunggu verifikasi Ketua RT.",
      user:{id:saved.id,nama_lengkap:saved.nama_lengkap || nama_lengkap,no_hp,status_warga:didaftarkanKetuaRT ? "aktif" : "menunggu_verifikasi"}
    });
  } catch (error) {
    console.error("REGISTER WARGA ERROR:", error?.message || error);
    if (getSupabaseErrorCode(error) === "23505") {
      return res.status(409).json({ok:false,message:"NIK atau nomor HP sudah terdaftar. Periksa kembali data pendaftaran."});
    }
    return res.status(500).json({ok:false,message:"Gagal mendaftarkan akun warga. Silakan coba kembali."});
  }
});
/* LOGIN */
app.post("/api/login", async (req, res) => {
  try {
    const { username, password, role } = req.body || {};

    if (!["admin", "warga", "bendahara", "sekretaris", "ketua_gang"].includes(role)) {
      return res.status(400).json({
        ok: false,
        message: "Jenis akun tidak valid"
      });
    }

    if (
      typeof username !== "string" ||
      !username.trim() ||
      username.length > 120 ||
      typeof password !== "string" ||
      !password ||
      password.length > 1024
    ) {
      return res.status(400).json({
        ok: false,
        message: "Username dan password wajib diisi dengan format yang benar"
      });
    }

    // Fail closed with a clear service response if deployment secrets are missing.
    // SESSION_SECRET must be at least 32 bytes of random material.
    const sessionSecret = process.env.SESSION_SECRET;
    if (typeof sessionSecret !== "string" || Buffer.byteLength(sessionSecret, "utf8") < 32) {
      console.error("LOGIN CONFIG ERROR: SESSION_SECRET is missing or too short");
      return res.status(503).json({
        ok: false,
        message: "Layanan login sedang tidak siap. Silakan coba kembali nanti."
      });
    }

    // Persistent account-based throttling shared by all Vercel instances.
    const rateLimitKey = createRateLimitKey(sessionSecret, "login", role + ":" + username);
    const rateLimitRows = await supabaseRequest("rpc/consume_login_rate_limit", {
      method: "POST",
      body: { p_key_hash: rateLimitKey, p_window_seconds: 900, p_max_attempts: 5 }
    });
    const rateLimit = Array.isArray(rateLimitRows) ? rateLimitRows[0] : rateLimitRows;
    if (!rateLimit || typeof rateLimit.allowed !== "boolean") {
      throw new Error("Respons pembatasan login tidak valid");
    }
    if (!rateLimit.allowed) {
      const retryAfter = Math.max(1, Number(rateLimit.retry_after_seconds) || 900);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        ok: false,
        message: "Terlalu banyak percobaan login. Silakan coba lagi beberapa menit kemudian."
      });
    }

if (role === "warga") {
  if (!username || !password) {
    return res.status(400).json({
      ok: false,
      message: "Nomor HP dan password wajib diisi"
    });
  }

  const data = await supabaseRequest("warga", {
    query:
      `select=id,nik,no_kk,nama_lengkap,alamat,no_hp,status_warga,password` +
      `&no_hp=eq.${encodeURIComponent(username)}` +
      `&limit=1`
  });

  if (!Array.isArray(data) || !data.length) {
    return res.status(401).json({
      ok: false,
      message: "Nomor HP atau password salah"
    });
  }

  const warga = data[0];
  const storedPassword = warga.password;

  let passwordValid = false;

  if (storedPassword && storedPassword.includes(":")) {
    passwordValid = verifyPassword(password, storedPassword);
  } else {
    passwordValid = password === storedPassword;

    if (passwordValid) {
      await supabaseRequest("warga", {
        method: "PATCH",
        query:
          `id=eq.${encodeURIComponent(warga.id)}`,
        body: {
          password: hashPassword(password)
        }
      });
    }
  }

  if (!passwordValid) {
    return res.status(401).json({
      ok: false,
      message: "Nomor HP atau password salah"
    });
  }
if (warga.status_warga === "menunggu_verifikasi") {
  return res.status(403).json({
    ok: false,
    message: "Akun Anda masih menunggu verifikasi Ketua RT"
  });
}

if (warga.status_warga !== "aktif") {
  return res.status(403).json({
    ok: false,
    message: "Akun Anda sudah dinonaktifkan oleh Ketua RT"
  });
}

await supabaseRequest("login_rate_limits", {
  method: "DELETE",
  query: "key_hash=eq." + encodeURIComponent(rateLimitKey)
});

const token = createSessionToken({
  id: warga.id,
  wargaId: warga.id,
  username: warga.no_hp,
  role: "warga",
  nama: warga.nama_lengkap
});


  res.setHeader(
    "Set-Cookie",
    `rt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; Max-Age=28800; SameSite=Lax`
  );

  return res.json({
    ok: true,
    user: {
      id: warga.id,
      username: warga.no_hp,
      nama: warga.nama_lengkap,
      role: "warga"
    }
  });
}
   if (["bendahara", "sekretaris", "ketua_gang"].includes(role)) {
      const staffRows = await supabaseRequest("petugas_rt", {
        query: "select=id,username,nama_lengkap,password,role,gang,status&username=eq." +
          encodeURIComponent(username.trim()) + "&role=eq." + encodeURIComponent(role) + "&limit=1"
      });
      const staff = Array.isArray(staffRows) ? staffRows[0] : null;
      if (!staff || staff.status !== "aktif" || !staff.password || !verifyPassword(password, staff.password)) {
        return res.status(401).json({ ok: false, message: "Username atau password salah" });
      }
      await supabaseRequest("login_rate_limits", { method: "DELETE", query: "key_hash=eq." + encodeURIComponent(rateLimitKey) });
      const token = createSessionToken({ id: staff.id, username: staff.username, nama: staff.nama_lengkap, role: staff.role, gang: staff.gang || "" });
      res.setHeader("Set-Cookie", `rt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; Max-Age=28800; SameSite=Lax`);
      return res.json({ ok: true, user: { id: staff.id, username: staff.username, nama: staff.nama_lengkap, role: staff.role, gang: staff.gang || "" } });
    }

   if (!ADMIN_PASSWORD) {
  return res.status(500).json({
    ok: false,
    message: "Login belum dikonfigurasi"
  });
}
    if (
      username !== ADMIN_USER ||
      !constantTimeStringEqual(password, ADMIN_PASSWORD)
    ) {
      return res.status(401).json({
        ok: false,
        message: "Username atau password salah"
      });
    }


await supabaseRequest("login_rate_limits", {
  method: "DELETE",
  query: "key_hash=eq." + encodeURIComponent(rateLimitKey)
});

const token = createSessionToken({
  id: "admin",
  username,
  role: "admin"
});

    res.setHeader(
      "Set-Cookie",
     `rt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; Max-Age=28800; SameSite=Lax`
    );

    res.json({
      ok: true,
      user: {
        id: "admin",
        username,
        role: "admin"
      }
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error?.message || error);

    res.status(503).json({
      ok: false,
      message: "Layanan login sementara tidak tersedia. Silakan coba lagi."
    });
  }
});


/* LOGOUT */
app.post("/api/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    "rt_token=; Path=/; HttpOnly; Secure; Max-Age=0; SameSite=Lax"
  );

  res.json({ ok: true });
});


/* CEK LOGIN */
app.get("/api/me", requireLogin, (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.session.id,
      username: req.session.username,
      nama: req.session.nama || "",
      role: req.session.role,
      gang: req.session.gang || ""
    }
  });
});

/* MANAJEMEN AKUN PETUGAS - KHUSUS KETUA RT */
app.get("/api/petugas", requireAdmin, async (req, res) => {
  try {
    const rows = await supabaseRequest("petugas_rt", { query: "select=id,username,nama_lengkap,role,gang,status,created_at&order=created_at.desc" });
    res.json(Array.isArray(rows) ? rows : []);
  } catch (error) { console.error("PETUGAS LIST ERROR:", error); res.status(500).json({ ok:false, message:"Gagal memuat akun petugas" }); }
});
app.post("/api/petugas", requireAdmin, async (req, res) => {
  try {
    const username=String(req.body?.username||"").trim().toLowerCase(), nama=String(req.body?.nama_lengkap||"").trim();
    const password=req.body?.password, role=String(req.body?.role||""), gang=String(req.body?.gang||"").trim();
    if(!/^[a-z0-9._-]{4,40}$/.test(username)||nama.length<3||nama.length>120||typeof password!=="string"||password.length<10||password.length>128||!["bendahara","sekretaris","ketua_gang"].includes(role)||(role==="ketua_gang"&&(!gang||gang.length>80)))
      return res.status(400).json({ok:false,message:"Data tidak valid. Password minimal 10 karakter; Ketua Gang wajib memiliki nama gang."});
    const created=await supabaseRequest("petugas_rt",{method:"POST",query:"select=id,username,nama_lengkap,role,gang,status,created_at",headers:{Prefer:"return=representation"},body:{username,nama_lengkap:nama,password:hashPassword(password),role,gang:role==="ketua_gang"?gang:null,status:"aktif"}});
    res.status(201).json({ok:true,user:Array.isArray(created)?created[0]:created});
  } catch(error){console.error("PETUGAS CREATE ERROR:",error);res.status(500).json({ok:false,message:"Gagal membuat akun. Pastikan username belum digunakan."});}
});
app.patch("/api/petugas/:id/status", requireAdmin, async (req,res)=>{
  try{
    const id=String(req.params.id||""),status=String(req.body?.status||"");
    if(!/^\d+$/.test(id)||!["aktif","nonaktif"].includes(status))return res.status(400).json({ok:false,message:"Data status tidak valid"});
    await supabaseRequest("petugas_rt",{method:"PATCH",query:"id=eq."+encodeURIComponent(id),body:{status,updated_at:new Date().toISOString()}});
    res.json({ok:true});
  }catch(error){console.error("PETUGAS STATUS ERROR:",error);res.status(500).json({ok:false,message:"Gagal mengubah status akun"});}
});
app.get("/api/ketua-gang/warga", requireGangLead, async(req,res)=>{
  try{
    const gang=String(req.session.gang||"").trim();
    if(!gang)return res.status(403).json({ok:false,message:"Wilayah gang belum ditetapkan"});
    const rows=await supabaseRequest("warga",{query:"select=id,nama_lengkap,alamat,status_warga,gang&gang=eq."+encodeURIComponent(gang)+"&order=nama_lengkap.asc"});
    res.json(Array.isArray(rows)?rows:[]);
  }catch(error){console.error("KETUA GANG WARGA ERROR:",error);res.status(500).json({ok:false,message:"Gagal memuat data warga gang"});}
});

/* DASHBOARD KETUA RT */
app.get("/api/dashboard", requireAdmin, async (req, res) => {
  try {
    const warga = await supabaseRequest("warga", {
      query: "select=id&limit=1000"
    });

    const surat = await supabaseRequest("pengajuan_surat", {
      query: "select=id&limit=1000"
    });

    const kas = await supabaseRequest("kas_rt", {
      query: "select=jenis,jumlah&limit=1000"
    });

    const complaints = await supabaseRequest("notifikasi", {
      query: "select=id&penerima_peran=eq.admin&jenis=eq.pengaduan&limit=1000"
    });

    let balance = 0;

    if (Array.isArray(kas)) {
      for (const item of kas) {
        const jumlah = Number(item.jumlah) || 0;
        const jenis = String(item.jenis || "").toLowerCase();

        if (
          jenis === "keluar" ||
          jenis === "pengeluaran"
        ) {
          balance -= jumlah;
        } else {
          balance += jumlah;
        }
      }
    }

    res.json({
      residents: Array.isArray(warga) ? warga.length : 0,
      letters: Array.isArray(surat) ? surat.length : 0,
      complaints: Array.isArray(complaints) ? complaints.length : 0,
      balance
    });
  } catch (error) {
    console.error("DASHBOARD ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil dashboard"
    });
  }
});

/* NOTIFIKASI — DAFTAR ADMIN DAN WARGA */
app.get("/api/notifikasi", requireLogin, async (req, res) => {
  try {
    const session = req.session;
    let query =
      "select=id,penerima_peran,penerima_warga_id,judul,pesan,jenis,tautan,referensi_id,sudah_dibaca,dibuat_pada&order=dibuat_pada.desc&limit=100";

    if (session.role === "admin") {
      query += "&penerima_peran=eq.admin";
    } else if (session.role === "warga") {
      if (!session.wargaId) {
        return res.status(403).json({
          ok: false,
          message: "Identitas warga tidak ditemukan"
        });
      }

      query +=
        "&penerima_peran=eq.warga" +
        "&penerima_warga_id=eq." +
        encodeURIComponent(session.wargaId);
    } else {
      return res.status(403).json({
        ok: false,
        message: "Akses ditolak"
      });
    }

    const data = await supabaseRequest("notifikasi", {
      query
    });

    const rows = Array.isArray(data) ? data : [];

    res.json({
      ok: true,
      notifikasi: rows,
      belum_dibaca: rows.filter(item => !item.sudah_dibaca).length
    });
  } catch (error) {
    console.error("NOTIFIKASI ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil notifikasi"
    });
  }
});

/* NOTIFIKASI — TANDAI SUDAH DIBACA */
app.patch("/api/notifikasi/:id/baca", requireLogin, async (req, res) => {
  try {
    const session = req.session;
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        message: "ID notifikasi tidak valid"
      });
    }

    let query =
      "id=eq." + id +
      "&select=id,penerima_peran,penerima_warga_id";

    if (session.role === "admin") {
      query += "&penerima_peran=eq.admin";
    } else if (session.role === "warga" && session.wargaId) {
      query +=
        "&penerima_peran=eq.warga" +
        "&penerima_warga_id=eq." +
        encodeURIComponent(session.wargaId);
    } else {
      return res.status(403).json({
        ok: false,
        message: "Akses ditolak"
      });
    }

    const found = await supabaseRequest("notifikasi", { query });

    if (!Array.isArray(found) || found.length === 0) {
      return res.status(404).json({
        ok: false,
        message: "Notifikasi tidak ditemukan"
      });
    }

    await supabaseRequest("notifikasi", {
      method: "PATCH",
      query:
  "id=eq." + id +
  "&penerima_peran=eq." + session.role +
  (session.role === "warga"
    ? "&penerima_warga_id=eq." + encodeURIComponent(session.wargaId)
    : ""),
      body: {
        sudah_dibaca: true,
        dibaca_pada: new Date().toISOString()
      }
    });

    res.json({
      ok: true,
      message: "Notifikasi ditandai sudah dibaca"
    });
  } catch (error) {
    console.error("TANDAI NOTIFIKASI ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal memperbarui notifikasi"
    });
  }
});



/* DATA WARGA - KETUA RT */
app.get("/api/residents", requireAdmin, async (req, res) => {
  try {
    const data = await supabaseRequest("warga", {
      query:
        "select=id,foto_profil,nik,no_kk,nama_lengkap,jenis_kelamin,tempat_lahir,tanggal_lahir,alamat,rt,rw,status_perkawinan,pekerjaan,no_hp,status_hunian,status_warga,hubungan_keluarga,keluarga_id,gang,created_at&order=nama_lengkap.asc"
    });

    const rows = Array.isArray(data)
      ? await Promise.all(
          data.map(async (row) => ({
            ...row,
            nama: row.nama_lengkap,
            foto_url: await buatUrlFotoPrivat(row.foto_profil)
          }))
        )
      : [];

    res.json(rows);
  } catch (error) {
    console.error("RESIDENTS ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil data warga"
    });
  }
});

/* VERIFIKASI WARGA - KETUA RT */
app.patch("/api/residents/:id/verify", requireAdmin, async (req, res) => {
  try {
    const data = await supabaseRequest("warga", {
      method: "PATCH",
      query:
        `id=eq.${encodeURIComponent(req.params.id)}`,
      body: {
        status_warga: "aktif"
      }
    });

    const row = Array.isArray(data) ? data[0] : data;

    res.json({
      ok: true,
      message: "Warga berhasil diverifikasi",
      data: dataWargaAman(row)
    });
  } catch (error) {
    console.error("VERIFY WARGA ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal memverifikasi warga"
    });
  }
});
/* NONAKTIFKAN WARGA - KETUA RT */
app.patch("/api/residents/:id/deactivate", requireAdmin, async (req, res) => {
  try {
    const data = await supabaseRequest("warga", {
      method: "PATCH",
      query:
        `id=eq.${encodeURIComponent(req.params.id)}`,
      body: {
        status_warga: "nonaktif"
      }
    });

    const row = Array.isArray(data) ? data[0] : data;

    res.json({
      ok: true,
      message: "Warga berhasil dinonaktifkan",
      data: dataWargaAman(row)
    });
  } catch (error) {
    console.error("DEACTIVATE WARGA ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal menonaktifkan warga"
    });
  }
});

/* AKTIFKAN KEMBALI WARGA - KETUA RT */
app.patch("/api/residents/:id/activate", requireAdmin, async (req, res) => {
  try {
    const data = await supabaseRequest("warga", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(req.params.id)}`,
      body: {
        status_warga: "aktif"
      }
    });

    const row = Array.isArray(data) ? data[0] : data;

    if (!row) {
      return res.status(404).json({
        ok: false,
        message: "Data warga tidak ditemukan"
      });
    }

    res.json({
      ok: true,
      message: "Warga berhasil diaktifkan kembali",
      data: dataWargaAman(row)
    });
  } catch (error) {
    console.error("ACTIVATE WARGA ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengaktifkan warga"
    });
  }
});


/* EDIT DATA WARGA - KETUA RT */
app.patch("/api/residents/:id", requireAdmin, async (req, res) => {
  try {
    const allowed = [
      "nik",
      "no_kk",
      "nama_lengkap",
      "jenis_kelamin",
      "tempat_lahir",
      "tanggal_lahir",
      "alamat",
      "rt",
      "rw",
      "status_perkawinan",
      "pekerjaan",
      "no_hp",
      "status_hunian",
      "hubungan_keluarga",
      "gang"
    ];

    const body = {};

    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        body[key] = req.body[key];
      }
    }

    if (!Object.keys(body).length) {
      return res.status(400).json({
        ok: false,
        message: "Tidak ada data yang diubah"
      });
    }

    if (body.nik !== undefined && String(body.nik).trim()) {
      const nik = String(body.nik).trim();
      const existing = await supabaseRequest("warga", {
        query: `select=id&nik=eq.${encodeURIComponent(nik)}&id=neq.${encodeURIComponent(req.params.id)}&limit=1`
      });

      if (Array.isArray(existing) && existing.length) {
        return res.status(409).json({
          ok: false,
          message: "NIK sudah digunakan warga lain"
        });
      }

      body.nik = nik;
    }

    if (body.no_kk !== undefined) {
      body.no_kk = String(body.no_kk).trim();
    }

    if (body.gang !== undefined) {
      body.gang = String(body.gang || "").trim();
      if (body.gang.length > 80) {
        return res.status(400).json({ ok: false, message: "Nama gang maksimal 80 karakter." });
      }
    }

    const data = await supabaseRequest("warga", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(req.params.id)}`,
      body
    });

    const row = Array.isArray(data) ? data[0] : data;

    if (!row) {
      return res.status(404).json({
        ok: false,
        message: "Data warga tidak ditemukan"
      });
    }

    res.json({
      ok: true,
      message: "Data warga berhasil diperbarui",
      data: dataWargaAman(row)
    });
  } catch (error) {
    console.error("EDIT WARGA ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal memperbarui data warga"
    });
  }
});

/* EXPORT DATA WARGA */
app.get("/api/residents/export", requireAdmin, async (req, res) => {
  try {
    const data = await supabaseRequest("warga", {
      query:
        "select=id,nik,no_kk,nama_lengkap,jenis_kelamin,tempat_lahir,tanggal_lahir,alamat,rt,rw,status_perkawinan,pekerjaan,no_hp,status_warga,hubungan_keluarga,keluarga_id,created_at&order=no_kk.asc,nama_lengkap.asc"
    });

    const rows = Array.isArray(data) ? data : [];
    const header = [
      "No", "No KK", "Hubungan dalam Keluarga", "Nama Lengkap", "NIK",
      "Jenis Kelamin", "Tempat Lahir", "Tanggal Lahir", "Status Perkawinan",
      "Pekerjaan", "No HP", "Alamat", "RT", "RW", "Status Warga",
      "ID Keluarga", "Tanggal Terdaftar"
    ];
    const csvRows = rows.map((row, index) => [
      index + 1, row.no_kk || "", row.hubungan_keluarga || "",
      row.nama_lengkap || "", row.nik || "", row.jenis_kelamin || "",
      row.tempat_lahir || "", row.tanggal_lahir || "",
      row.status_perkawinan || "", row.pekerjaan || "", row.no_hp || "",
      row.alamat || "", row.rt || "", row.rw || "",
      row.status_warga || "", row.keluarga_id || "", row.created_at || ""
    ]);
    const csv = [header, ...csvRows]
      .map(row => row.map(value => csvCell(value)).join(","))
      .join("\r\n");

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="data-warga-rt-tbk.csv"');
    res.send("\uFEFF" + csv);
  } catch (error) {
    console.error("EXPORT WARGA ERROR:", error);
    res.status(500).json({ ok: false, message: "Gagal export data warga" });
  }
});

/* TAMBAH WARGA */
app.post("/api/residents", requireAdmin, async (req, res) => {
  try {
    const {
      nama,
      nik,
      no_kk,
      alamat,
      no_hp
    } = req.body;

    if (!nama || !nik || !no_kk) {
      return res.status(400).json({
        ok: false,
        message: "Nama, NIK, dan No. KK wajib diisi"
      });
    }

    const data = await supabaseRequest("warga", {
      method: "POST",
      body: {
        nama_lengkap: nama,
        nik,
        no_kk,
        alamat: alamat || "",
        no_hp: no_hp || ""
      }
    });

    const row = Array.isArray(data) ? data[0] : data;

    res.json({
      ok: true,
      data: {
        ...dataWargaAman(row),
        nama: row?.nama_lengkap
      }
    });
  } catch (error) {
    console.error("ADD RESIDENT ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal menyimpan data warga"
    });
  }
});


/* UPLOAD FOTO PROFIL WARGA */
app.post(
  "/api/my-photo",
  requireWarga,
  uploadFoto.single("foto"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          message: "Pilih foto terlebih dahulu."
        });
      }

      const wargaId = req.session.wargaId;
      const jenisFoto = detectImageType(req.file.buffer);
      const ekstensi = jenisFoto?.ext;

      if (
        !jenisFoto ||
        req.file.mimetype !== jenisFoto.mime ||
        !["image/jpeg", "image/png", "image/webp"].includes(jenisFoto.mime)
      ) {
        return res.status(400).json({
          ok: false,
          message: "Format foto tidak diizinkan."
        });
      }

      const bucket = "foto warga";
      const objectPath = `warga/${wargaId}.${ekstensi}`;
      const encodedPath = objectPath
        .split("/")
        .map(encodeURIComponent)
        .join("/");

      const storageUrl =
        `${SUPABASE_URL}/storage/v1/object/` +
        `${encodeURIComponent(bucket)}/${encodedPath}`;

      const uploadResponse = await fetch(storageUrl, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": jenisFoto.mime,
          "x-upsert": "true"
        },
        body: req.file.buffer
      });

      if (!uploadResponse.ok) {
        const detail = await uploadResponse.text();
        console.error("UPLOAD FOTO ERROR:", detail);
        return res.status(502).json({
          ok: false,
          message: "Foto gagal diunggah ke penyimpanan."
        });
      }

      await supabaseRequest("warga", {
        method: "PATCH",
        query: `id=eq.${encodeURIComponent(wargaId)}`,
        body: {
          foto_profil: objectPath
        }
      });

      return res.json({
        ok: true,
        message: "Foto profil berhasil diunggah."
      });
    } catch (error) {
      console.error("MY PHOTO ERROR:", error);
      return res.status(500).json({
        ok: false,
        message: "Gagal menyimpan foto profil."
      });
    }
  }
);


/* ARSIP KK/KTP — KHUSUS KETUA RT. File disimpan di bucket privat. */
const IDENTITAS_BUCKET = "dokumen-identitas";

function validasiDokumenIdentitas(file) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer)) return null;
  if (file.mimetype === "application/pdf" && file.buffer.subarray(0,5).toString("ascii") === "%PDF-") {
    return { mime: "application/pdf", ext: "pdf" };
  }
  const image = detectImageType(file.buffer);
  if (!image || image.mime !== file.mimetype || !["image/jpeg","image/png","image/webp"].includes(image.mime)) return null;
  return { mime: image.mime, ext: image.ext };
}

async function uploadDokumenIdentitasPrivat(pathObject, buffer, contentType) {
  const encoded = pathObject.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(IDENTITAS_BUCKET)}/${encoded}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": contentType,
        "x-upsert": "false"
      },
      body: buffer,
      signal: AbortSignal.timeout(30000)
    }
  );
  if (!response.ok) {
    console.error("ARSIP IDENTITAS STORAGE ERROR:", response.status, await response.text());
    throw new Error("Gagal menyimpan dokumen ke penyimpanan privat.");
  }
}

async function hapusDokumenIdentitasPrivat(pathObject) {
  const encoded = pathObject.split("/").map(encodeURIComponent).join("/");
  await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(IDENTITAS_BUCKET)}/${encoded}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  }).catch(() => {});
}

async function buatSignedUrlIdentitas(pathObject) {
  const encoded = pathObject.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(IDENTITAS_BUCKET)}/${encoded}`,
    {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 300 }),
      signal: AbortSignal.timeout(10000)
    }
  );
  if (!response.ok) throw new Error("Tautan dokumen privat gagal dibuat.");
  const data = await response.json();
  if (!data.signedURL) throw new Error("Tautan dokumen tidak tersedia.");
  return data.signedURL.startsWith("http")
    ? data.signedURL
    : `${SUPABASE_URL}/storage/v1${data.signedURL.startsWith("/") ? "" : "/"}${data.signedURL}`;
}

app.get("/api/identitas", requireAdmin, async (req, res) => {
  try {
    const [families, docs] = await Promise.all([
      supabaseRequest("keluarga", { query: "select=id,no_kk,kepala_keluarga,alamat,rt,rw&order=created_at.desc&limit=2000" }),
      supabaseRequest("dokumen_identitas", { query: "select=id,keluarga_id,warga_id,jenis_dokumen,nama_file,mime_type,ukuran_bytes,ocr_text,ocr_data,status_verifikasi,uploaded_at&order=uploaded_at.desc&limit=5000" })
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      families: Array.isArray(families) ? families : [],
      documents: Array.isArray(docs) ? docs : []
    });
  } catch (error) {
    console.error("ARSIP IDENTITAS LIST ERROR:", error);
    res.status(503).json({ ok:false, message:"Arsip belum siap. Pastikan migrasi database sudah diterapkan." });
  }
});

app.post("/api/identitas/keluarga", requireAdmin, async (req, res) => {
  try {
    const no_kk = String(req.body?.no_kk || "").replace(/\D/g, "");
    const kepala_keluarga = String(req.body?.kepala_keluarga || "").trim().slice(0,120);
    const alamat = String(req.body?.alamat || "").trim().slice(0,500);
    const rt = String(req.body?.rt || "04").trim().slice(0,8);
    const rw = String(req.body?.rw || "01").trim().slice(0,8);
    if (!/^\d{16}$/.test(no_kk) || kepala_keluarga.length < 2 || !alamat) {
      return res.status(400).json({ok:false,message:"Nomor KK harus 16 digit, nama kepala keluarga dan alamat wajib diisi."});
    }
    const existing = await supabaseRequest("keluarga", { query: "select=id,no_kk,kepala_keluarga,alamat,rt,rw&no_kk=eq."+encodeURIComponent(no_kk)+"&limit=1" });
    if (Array.isArray(existing) && existing.length) {
      return res.json({ok:true,existing:true,family:existing[0],message:"Keluarga dengan nomor KK tersebut sudah terdaftar."});
    }
    const created = await supabaseRequest("keluarga", {
      method:"POST",
      body:{no_kk,kepala_keluarga,alamat,rt,rw}
    });
    const family = Array.isArray(created) ? created[0] : created;
    res.status(201).json({ok:true,existing:false,family});
  } catch (error) {
    console.error("ARSIP CREATE FAMILY ERROR:",error);
    res.status(500).json({ok:false,message:"Gagal membuat data keluarga."});
  }
});


app.post("/api/identitas/keluarga-otomatis", requireAdmin, async (req,res) => {
  try {
    const no_kk=String(req.body?.no_kk||"").replace(/\D/g,"");
    const kepala_keluarga=String(req.body?.kepala_keluarga||"").trim().slice(0,120);
    const alamat=String(req.body?.alamat||"").trim().slice(0,500);
    const rt=String(req.body?.rt||"004").trim().slice(0,8);
    const rw=String(req.body?.rw||"01").trim().slice(0,8);
    if(!/^\d{16}$/.test(no_kk)) return res.status(400).json({ok:false,message:"Nomor KK belum terbaca jelas. Foto ulang bagian nomor KK agar sistem dapat membuat data keluarga otomatis."});
    const existing=await supabaseRequest("keluarga",{query:"select=id,no_kk,kepala_keluarga,alamat,rt,rw&no_kk=eq."+encodeURIComponent(no_kk)+"&limit=1"});
    let family=Array.isArray(existing)?existing[0]:null;
    if(family){
      const patch={};
      if(kepala_keluarga&&!family.kepala_keluarga)patch.kepala_keluarga=kepala_keluarga;
      if(alamat&&!family.alamat)patch.alamat=alamat;
      if(rt&&!family.rt)patch.rt=rt;
      if(rw&&!family.rw)patch.rw=rw;
      if(Object.keys(patch).length){
        const updated=await supabaseRequest("keluarga",{method:"PATCH",query:"id=eq."+encodeURIComponent(String(family.id)),body:patch});
        family=Array.isArray(updated)?updated[0]:updated||{...family,...patch};
      }
      return res.json({ok:true,existing:true,family,message:"Data keluarga dengan nomor KK ini sudah ada; arsip akan ditambahkan ke keluarga yang sama."});
    }
    const inserted=await supabaseRequest("keluarga",{method:"POST",body:{no_kk,kepala_keluarga:kepala_keluarga||null,alamat:alamat||null,rt:rt||"004",rw:rw||"01"}});
    family=Array.isArray(inserted)?inserted[0]:inserted;
    if(!family?.id)throw new Error("ID keluarga tidak dikembalikan database.");
    res.status(201).json({ok:true,existing:false,family,message:"Data keluarga berhasil dibuat otomatis dari foto KK."});
  } catch(error) {
    console.error("AUTO CREATE FAMILY FROM KK ERROR:",error);
    res.status(500).json({ok:false,message:"Gagal membuat data keluarga otomatis dari KK."});
  }
});

app.post("/api/identitas/keluarga/:id/anggota-kk", requireAdmin, async(req,res)=>{
  try{
    const familyId=String(req.params.id||"");
    const members=Array.isArray(req.body?.anggota)?req.body.anggota.slice(0,20):[];
    if(!/^\d+$/.test(familyId)||!members.length)return res.status(400).json({ok:false,message:"Daftar anggota KK kosong atau tidak valid."});
    const families=await supabaseRequest("keluarga",{query:"select=id,no_kk,alamat,rt,rw&id=eq."+encodeURIComponent(familyId)+"&limit=1"});
    const family=Array.isArray(families)?families[0]:null;
    if(!family)return res.status(404).json({ok:false,message:"Data keluarga tidak ditemukan."});
    let created=0,duplicates=0,skipped=0;
    for(const member of members){
      const nik=String(member?.nik||"").replace(/\D/g,"");
      const nama=String(member?.nama_lengkap||"").trim().slice(0,120);
      const hubungan=String(member?.hubungan_keluarga||"Lainnya").trim();
      const jk=String(member?.jenis_kelamin||"");
      if(!/^\d{16}$/.test(nik)||nama.length<3||!["Kepala Keluarga","Istri","Suami","Anak","Orang Tua","Lainnya"].includes(hubungan)|| (jk&&!["Laki-laki","Perempuan"].includes(jk))){skipped++;continue;}
      const existing=await supabaseRequest("warga",{query:"select=id,keluarga_id&nik=eq."+encodeURIComponent(nik)+"&limit=1"});
      const warga=Array.isArray(existing)?existing[0]:null;
      if(warga){if(String(warga.keluarga_id)!==familyId)duplicates++;else skipped++;continue;}
      await supabaseRequest("warga",{method:"POST",body:{
        nik,nama_lengkap:nama,no_kk:family.no_kk,jenis_kelamin:jk||null,
        alamat:family.alamat||"",rt:family.rt||"004",rw:family.rw||"01",
        hubungan_keluarga:hubungan,keluarga_id:Number(familyId),status_warga:"menunggu_verifikasi"
      }});
      created++;
    }
    res.status(200).json({ok:true,created,duplicates,skipped,message:"Anggota yang terbaca dari KK dicatat dan menunggu verifikasi Ketua RT."});
  }catch(error){
    console.error("CREATE FAMILY MEMBERS FROM KK ERROR:",error);
    res.status(500).json({ok:false,message:"Gagal mencatat anggota dari KK. Arsip KK tetap tersimpan."});
  }
});

app.post("/api/identitas/:id/anggota-otomatis", requireAdmin, async(req,res)=>{
  try{
    const docId=String(req.params.id||"");
    const nama=String(req.body?.nama_lengkap||"").trim().slice(0,120);
    const nik=String(req.body?.nik||"").replace(/\D/g,"");
    const jenisKelamin=String(req.body?.jenis_kelamin||"");
    const tempatLahir=String(req.body?.tempat_lahir||"").trim().slice(0,100);
    const tanggalLahir=String(req.body?.tanggal_lahir||"").trim();
    const hubungan=String(req.body?.hubungan_keluarga||"Anggota Keluarga").trim().slice(0,50);
    if(!/^\d+$/.test(docId)||nama.length<2||!/^\d{16}$/.test(nik))
      return res.status(400).json({ok:false,message:"Nama atau NIK KTP belum terbaca jelas; dokumen tetap tersimpan untuk diperiksa."});
    if(jenisKelamin&&!["Laki-laki","Perempuan"].includes(jenisKelamin))
      return res.status(400).json({ok:false,message:"Jenis kelamin hasil OCR tidak valid."});
    if(tanggalLahir&&!/^\d{4}-\d{2}-\d{2}$/.test(tanggalLahir))
      return res.status(400).json({ok:false,message:"Tanggal lahir hasil OCR tidak valid."});
    const docs=await supabaseRequest("dokumen_identitas",{query:"select=id,keluarga_id,jenis_dokumen,warga_id&id=eq."+encodeURIComponent(docId)+"&limit=1"});
    const doc=Array.isArray(docs)?docs[0]:null;
    if(!doc||doc.jenis_dokumen!=="KTP")return res.status(404).json({ok:false,message:"Arsip KTP tidak ditemukan."});
    const familyRows=await supabaseRequest("keluarga",{query:"select=id,no_kk,kepala_keluarga,alamat,rt,rw&id=eq."+encodeURIComponent(String(doc.keluarga_id))+"&limit=1"});
    const family=Array.isArray(familyRows)?familyRows[0]:null;
    if(!family)return res.status(404).json({ok:false,message:"Data keluarga hasil pembacaan KK tidak ditemukan."});
    const existing=await supabaseRequest("warga",{query:"select=id,keluarga_id,nama_lengkap,nik&nik=eq."+encodeURIComponent(nik)+"&limit=1"});
    let warga=Array.isArray(existing)?existing[0]:null;
    if(doc.warga_id&&(!warga||String(warga.id)!==String(doc.warga_id)))
      return res.status(409).json({ok:false,message:"Foto KTP ini sudah tertaut ke anggota lain. Periksa arsip sebelum mengubahnya."});
    if(warga&&String(warga.keluarga_id)!==String(doc.keluarga_id))
      return res.status(409).json({ok:false,message:"NIK sudah terdaftar pada keluarga lain. Dokumen disimpan tetapi tidak dibuat sebagai warga ganda."});
    if(!warga){
      const namaNormal=s=>String(s||"").normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]/g,"");
      const relasiAman=family.kepala_keluarga&&namaNormal(nama)===namaNormal(family.kepala_keluarga)
        ? "Kepala Keluarga"
        : (["Istri","Suami","Anak","Orang Tua","Lainnya","Anggota Keluarga"].includes(hubungan)?hubungan:"Anggota Keluarga");
      const inserted=await supabaseRequest("warga",{method:"POST",body:{
        nama_lengkap:nama,nik,no_kk:family.no_kk,jenis_kelamin:jenisKelamin||null,
        tempat_lahir:tempatLahir||null,tanggal_lahir:tanggalLahir||null,
        alamat:family.alamat||"",rt:family.rt||"004",rw:family.rw||"01",
        hubungan_keluarga:relasiAman,keluarga_id:doc.keluarga_id,
        status_warga:"menunggu_verifikasi"
      }});
      warga=Array.isArray(inserted)?inserted[0]:inserted;
    }
    await supabaseRequest("dokumen_identitas",{method:"PATCH",query:"id=eq."+encodeURIComponent(docId),body:{warga_id:warga.id}});
    res.status(200).json({ok:true,created:true,message:"Data anggota keluarga dibuat otomatis dari KTP dan menunggu pemeriksaan Ketua RT.",warga:{id:warga.id,nama_lengkap:warga.nama_lengkap,nik:warga.nik}});
  }catch(error){
    console.error("AUTO REGISTER KTP ERROR:",error);
    res.status(500).json({ok:false,message:"Gagal mencatat data KTP otomatis. Dokumen asli tetap tersimpan."});
  }
});

app.post("/api/identitas/upload", requireAdmin, uploadDokumenIdentitas.single("file"), async (req,res) => {
  let storagePath="";
  try {
    const keluargaId=String(req.body?.keluarga_id||"").trim();
    const kind=String(req.body?.jenis_dokumen||"");
    const file=req.file;
    if(!/^[0-9]+$/.test(keluargaId)||!["KK","KTP"].includes(kind)||!file)
      return res.status(400).json({ok:false,message:"Data keluarga, jenis dokumen, atau file tidak valid."});
    const valid=validasiDokumenIdentitas(file);
    if(!valid) return res.status(400).json({ok:false,message:"Isi file tidak cocok dengan format JPG, PNG, WebP, atau PDF."});
    const familyRows=await supabaseRequest("keluarga",{query:"select=id&id=eq."+encodeURIComponent(keluargaId)+"&limit=1"});
    if(!Array.isArray(familyRows)||!familyRows.length)return res.status(404).json({ok:false,message:"Data keluarga tidak ditemukan."});

    // Idempotensi: jika file yang sama sudah tercatat, kembalikan arsip lama.
    // Bandingkan SHA-256 isi file, bukan hanya nama/ukuran, agar dua KTP berbeda
    // yang kebetulan bernama sama tidak tertukar.
    const incomingHash=crypto.createHash("sha256").update(file.buffer).digest("hex");
    const candidateRows=await supabaseRequest("dokumen_identitas",{
      query:"select=id,keluarga_id,jenis_dokumen,storage_path,nama_file,mime_type,ukuran_bytes,status_verifikasi&keluarga_id=eq."+encodeURIComponent(keluargaId)+
        "&jenis_dokumen=eq."+encodeURIComponent(kind)+"&nama_file=eq."+encodeURIComponent(String(file.originalname||"dokumen").slice(0,180))+
        "&ukuran_bytes=eq."+encodeURIComponent(String(file.size))+"&order=uploaded_at.desc&limit=20"
    });
    for(const candidate of (Array.isArray(candidateRows)?candidateRows:[])){
      if(!candidate.storage_path)continue;
      try{
        const signed=await buatSignedUrlIdentitas(String(candidate.storage_path));
        const existingResponse=await fetch(signed,{signal:AbortSignal.timeout(10000)});
        if(!existingResponse.ok)continue;
        const existingBuffer=Buffer.from(await existingResponse.arrayBuffer());
        const existingHash=crypto.createHash("sha256").update(existingBuffer).digest("hex");
        if(existingHash===incomingHash){
          return res.status(200).json({ok:true,duplicate:true,document:{
            id:candidate.id,keluarga_id:candidate.keluarga_id,jenis_dokumen:candidate.jenis_dokumen,
            nama_file:candidate.nama_file,mime_type:candidate.mime_type,ukuran_bytes:candidate.ukuran_bytes,
            status_verifikasi:candidate.status_verifikasi
          }});
        }
      }catch(duplicateCheckError){
        console.warn("IDENTITY DUPLICATE CHECK SKIPPED:",duplicateCheckError?.message||duplicateCheckError);
      }
    }

    const safeName=String(file.originalname||"dokumen").normalize("NFKD").replace(/[^a-zA-Z0-9._-]/g,"_").slice(-90)||"dokumen";
    storagePath=keluargaId+"/"+crypto.randomUUID()+"-"+safeName;
    await uploadDokumenIdentitasPrivat(storagePath,file.buffer,valid.mime);
    const inserted=await supabaseRequest("dokumen_identitas",{method:"POST",body:{
      keluarga_id:Number(keluargaId),jenis_dokumen:kind,storage_path:storagePath,nama_file:String(file.originalname||safeName).slice(0,180),
      mime_type:valid.mime,ukuran_bytes:file.size,uploaded_by:String(req.session?.nama||req.session?.username||"Ketua RT").slice(0,120),
      status_verifikasi:"menunggu_verifikasi"
    }});
    const row=Array.isArray(inserted)?inserted[0]:inserted;
    if(!row?.id)throw new Error("Catatan arsip tidak berhasil dibuat.");
    return res.status(201).json({ok:true,document:{id:row.id,keluarga_id:row.keluarga_id,jenis_dokumen:row.jenis_dokumen,
      nama_file:row.nama_file,mime_type:row.mime_type,ukuran_bytes:row.ukuran_bytes,status_verifikasi:row.status_verifikasi}});
  } catch(error) {
    if(storagePath) await hapusDokumenIdentitasPrivat(storagePath);
    console.error("IDENTITY PROXY UPLOAD ERROR:",error);
    return res.status(500).json({ok:false,message:"Upload melalui server gagal. Dokumen belum dinyatakan tersimpan."});
  }
});

app.post("/api/identitas/upload-url", requireAdmin, async (req,res) => {
  try {
    const keluargaId=String(req.body?.keluarga_id||"").trim();
    const kind=String(req.body?.jenis_dokumen||"");
    const mime=String(req.body?.mime_type||"").toLowerCase();
    const size=Number(req.body?.ukuran_bytes);
    const originalName=String(req.body?.nama_file||"dokumen").slice(0,180);
    const allowed=["image/jpeg","image/png","image/webp","application/pdf"];
    if(!/^[0-9]+$/.test(keluargaId)||!["KK","KTP"].includes(kind)||!allowed.includes(mime)||!Number.isSafeInteger(size)||size<1||size>8388608)
      return res.status(400).json({ok:false,message:"Data file tidak valid. Maksimal 8 MB per dokumen."});
    const familyRows=await supabaseRequest("keluarga",{query:"select=id&id=eq."+encodeURIComponent(keluargaId)+"&limit=1"});
    if(!Array.isArray(familyRows)||!familyRows.length)return res.status(404).json({ok:false,message:"Data keluarga tidak ditemukan."});
    const safeName=originalName.normalize("NFKD").replace(/[^a-zA-Z0-9._-]/g,"_").slice(-90)||"dokumen";
    const ext=mime==="application/pdf"?"pdf":mime==="image/jpeg"?"jpg":mime==="image/png"?"png":"webp";
    const storagePath=String(keluargaId)+"/"+crypto.randomUUID()+"-"+safeName;
    const encoded=storagePath.split("/").map(encodeURIComponent).join("/");
    const signedResponse=await fetch(
      `${SUPABASE_URL}/storage/v1/object/upload/sign/${encodeURIComponent(IDENTITAS_BUCKET)}/${encoded}`,
      {method:"POST",headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({}),signal:AbortSignal.timeout(10000)}
    );
    const signedData=await signedResponse.json().catch(()=>({}));
    if(!signedResponse.ok||!signedData.url){
      console.error("CREATE SIGNED IDENTITY UPLOAD ERROR:",signedResponse.status,signedData);
      return res.status(502).json({ok:false,message:"Tidak dapat menyiapkan unggahan aman."});
    }
    const uploadUrl=String(signedData.url).startsWith("http")?signedData.url:
      `${SUPABASE_URL}/storage/v1${String(signedData.url).startsWith("/")?"":"/"}${signedData.url}`;
    res.setHeader("Cache-Control","no-store");
    res.json({ok:true,upload_url:uploadUrl,storage_path:storagePath,jenis_dokumen:kind,mime_type:mime,ukuran_bytes:size,nama_file:safeName});
  }catch(error){
    console.error("PREPARE IDENTITY UPLOAD ERROR:",error);
    res.status(500).json({ok:false,message:"Gagal menyiapkan unggahan dokumen."});
  }
});

app.post("/api/identitas/register-upload", requireAdmin, async(req,res)=>{
  try{
    const keluargaId=String(req.body?.keluarga_id||"").trim();
    const storagePath=String(req.body?.storage_path||"");
    const kind=String(req.body?.jenis_dokumen||"");
    const mime=String(req.body?.mime_type||"").toLowerCase();
    const size=Number(req.body?.ukuran_bytes);
    const name=String(req.body?.nama_file||"dokumen").slice(0,180);
    if(!/^[0-9]+$/.test(keluargaId)||!storagePath.startsWith(keluargaId+"/")||!(new RegExp("^"+keluargaId+"/[0-9a-f-]{36}-[a-zA-Z0-9._-]{1,90}$","i")).test(storagePath)||
      !["KK","KTP"].includes(kind)||!["image/jpeg","image/png","image/webp","application/pdf"].includes(mime)||
      !Number.isSafeInteger(size)||size<1||size>8388608)
      return res.status(400).json({ok:false,message:"Metadata dokumen tidak valid."});
    const encoded=storagePath.split("/").map(encodeURIComponent).join("/");
    const head=await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(IDENTITAS_BUCKET)}/${encoded}`,{
      method:"HEAD",headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`},signal:AbortSignal.timeout(10000)
    });
    if(!head.ok)return res.status(409).json({ok:false,message:"File belum berhasil masuk ke penyimpanan."});
    const actualType=String(head.headers.get("content-type")||"").split(";")[0].toLowerCase();
    if(actualType&&actualType!==mime)return res.status(400).json({ok:false,message:"Jenis file yang tersimpan tidak cocok."});
    const inserted=await supabaseRequest("dokumen_identitas",{
      method:"POST",
      body:{keluarga_id:Number(keluargaId),jenis_dokumen:kind,storage_path:storagePath,nama_file:name,mime_type:mime,
        ukuran_bytes:size,uploaded_by:String(req.session?.nama||req.session?.username||"Ketua RT").slice(0,120),
        status_verifikasi:"menunggu_verifikasi"}
    });
    const row=Array.isArray(inserted)?inserted[0]:inserted;
    res.status(201).json({ok:true,document:{id:row.id,keluarga_id:row.keluarga_id,jenis_dokumen:row.jenis_dokumen,
      nama_file:row.nama_file,mime_type:row.mime_type,ukuran_bytes:row.ukuran_bytes,status_verifikasi:row.status_verifikasi}});
  }catch(error){
    console.error("REGISTER IDENTITY UPLOAD ERROR:",error);
    res.status(500).json({ok:false,message:"File sudah diunggah, tetapi pencatatan arsip gagal. Hubungi pengelola."});
  }
});


app.delete("/api/identitas/arsip-upload", requireAdmin, async (req,res) => {
  try {
    // Enumerate the entire private identity bucket, including orphaned uploads
    // that no longer have a row in dokumen_identitas.
    const paths = [];
    const visited = new Set();
    async function listFolder(prefix) {
      if (visited.has(prefix)) return;
      visited.add(prefix);
      for (let offset = 0; ; offset += 1000) {
        const response = await fetch(
          `${SUPABASE_URL}/storage/v1/object/list/${encodeURIComponent(IDENTITAS_BUCKET)}`,
          {
            method: "POST",
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
            signal: AbortSignal.timeout(15000)
          }
        );
        const items = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(items)) {
          throw new Error("Daftar file Storage gagal dibaca; tidak ada catatan database yang dihapus.");
        }
        for (const item of items) {
          const name = String(item?.name || "");
          if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\\\")) {
            throw new Error("Nama/path objek Storage tidak valid; penghapusan dihentikan.");
          }
          if (item.id === null || item.id === undefined) {
            await listFolder(prefix ? `${prefix}${name}/` : `${name}/`);
          } else {
            paths.push(prefix ? `${prefix}${name}` : name);
          }
        }
        if (items.length < 1000) break;
      }
    }
    await listFolder("");

    let filesDeleted = 0;
    for (let i = 0; i < paths.length; i += 1000) {
      const batch = paths.slice(i, i + 1000);
      const response = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(IDENTITAS_BUCKET)}`,
        {
          method: "DELETE",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ prefixes: batch }),
          signal: AbortSignal.timeout(30000)
        }
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error("DELETE IDENTITY STORAGE BATCH ERROR:", response.status, detail);
        throw new Error("Penghapusan file Storage gagal; arsip database belum dihapus.");
      }
      filesDeleted += batch.length;
    }

    const docs = await supabaseRequest("dokumen_identitas", {
      query: "select=id&order=id.asc&limit=5000"
    });
    const rows = Array.isArray(docs) ? docs : [];
    if (rows.length) {
      const deleted = await supabaseRequest("dokumen_identitas", {
        method: "DELETE",
        query: "id=not.is.null"
      });
      void deleted;
    }
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok:true, documents_deleted:rows.length, files_deleted:filesDeleted });
  } catch (error) {
    console.error("DELETE IDENTITY ARCHIVES ERROR:", error);
    return res.status(500).json({ ok:false, message:"Penghapusan arsip tidak selesai. Data warga dan keluarga tetap dipertahankan." });
  }
});

app.patch("/api/identitas/:id/ocr", requireAdmin, async (req,res) => {
  try {
    const id=String(req.params.id||"");
    const textOcr=String(req.body?.ocr_text||"").slice(0,50000);
    const nikCandidates=[...new Set(textOcr.match(/\b\d{16}\b/g)||[])];
    const lines=textOcr.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    let namaCandidate="";
    for(let i=0;i<lines.length;i++){
      const match=lines[i].match(/^N[4A]M[4A]\s*[:：-]?\s*(.*)$/i)||lines[i].match(/^NAMA\s*[:：-]?\s*(.*)$/i);
      if(match){
        const compact=value=>String(value||"").toUpperCase().replace(/[^A-Z]/g,"");
        const isRegion=value=>/^(PROVINSI|KABUPATEN|KABUPATENKOTA|KOTA|KECAMATAN|KELURAHAN|DESA|DUSUN)/.test(compact(value));
        const candidate=(match[1]||lines.slice(i+1,i+6).find(line=>line.length>=3&&!isRegion(line)&&!/^(NIK|TEMPAT|TGL|JENIS|ALAMAT|AGAMA|STATUS|PEKERJAAN)/i.test(line)&&!/^\d/.test(line))||"").trim();
        if(candidate&&!isRegion(candidate))namaCandidate=candidate.slice(0,120);
        break;
      }
    }
    if (!/^\d+$/.test(id) || !textOcr.trim()) return res.status(400).json({ok:false,message:"Hasil OCR tidak valid."});
    const updated=await supabaseRequest("dokumen_identitas",{
      method:"PATCH",query:"id=eq."+encodeURIComponent(id),
      body:{ocr_text:textOcr,ocr_data:{nik_candidates:nikCandidates,nama_candidate:namaCandidate,ocr_engine:"tesseract.js-browser",review_required:true}}
    });
    const row=Array.isArray(updated)?updated[0]:updated;
    if(!row)return res.status(404).json({ok:false,message:"Dokumen tidak ditemukan."});
    res.json({ok:true,nik_candidates:nikCandidates});
  }catch(error){
    console.error("SIMPAN OCR IDENTITAS ERROR:",error);
    res.status(500).json({ok:false,message:"Gagal menyimpan hasil OCR."});
  }
});

app.patch("/api/identitas/:id/verify", requireAdmin, async (req,res) => {
  try{
    const id=String(req.params.id||"");
    const status=String(req.body?.status_verifikasi||"");
    if(!/^\d+$/.test(id)||!["terverifikasi","perlu_perbaikan","menunggu_verifikasi"].includes(status))
      return res.status(400).json({ok:false,message:"Status verifikasi tidak valid."});
    const updated=await supabaseRequest("dokumen_identitas",{
      method:"PATCH",query:"id=eq."+encodeURIComponent(id),
      body:{status_verifikasi:status}
    });
    const row=Array.isArray(updated)?updated[0]:updated;
    if(!row)return res.status(404).json({ok:false,message:"Dokumen tidak ditemukan."});
    res.json({ok:true});
  }catch(error){
    console.error("VERIFIKASI DOKUMEN ERROR:",error);
    res.status(500).json({ok:false,message:"Gagal memperbarui status dokumen."});
  }
});


app.post("/api/identitas/:id/anggota", requireAdmin, async(req,res)=>{
  try{
    const docId=String(req.params.id||"");
    const nama=String(req.body?.nama_lengkap||"").trim().slice(0,120);
    const nik=String(req.body?.nik||"").replace(/\D/g,"");
    const jenisKelamin=String(req.body?.jenis_kelamin||"");
    const tempatLahir=String(req.body?.tempat_lahir||"").trim().slice(0,100);
    const tanggalLahir=String(req.body?.tanggal_lahir||"").trim();
    const hubungan=String(req.body?.hubungan_keluarga||"").trim();
    if(!/^[0-9]+$/.test(docId)||nama.length<2||! /^\d{16}$/.test(nik)||
      !["Laki-laki","Perempuan"].includes(jenisKelamin)||
      !["Kepala Keluarga","Istri","Suami","Anak","Orang Tua","Lainnya"].includes(hubungan)||
      (tanggalLahir&&!/^\d{4}-\d{2}-\d{2}$/.test(tanggalLahir))){
      return res.status(400).json({ok:false,message:"Periksa nama, NIK 16 digit, jenis kelamin, tanggal lahir, dan hubungan keluarga."});
    }
    const docs=await supabaseRequest("dokumen_identitas",{query:"select=id,keluarga_id,jenis_dokumen,warga_id&id=eq."+encodeURIComponent(docId)+"&limit=1"});
    const doc=Array.isArray(docs)?docs[0]:null;
    if(!doc||doc.jenis_dokumen!=="KTP")return res.status(404).json({ok:false,message:"Arsip KTP tidak ditemukan."});
    const familyRows=await supabaseRequest("keluarga",{query:"select=id,no_kk,alamat,rt,rw&id=eq."+encodeURIComponent(doc.keluarga_id)+"&limit=1"});
    const family=Array.isArray(familyRows)?familyRows[0]:null;
    if(!family)return res.status(404).json({ok:false,message:"Data keluarga tidak ditemukan."});
    const existing=await supabaseRequest("warga",{query:"select=id,keluarga_id,nama_lengkap,nik&nik=eq."+encodeURIComponent(nik)+"&limit=1"});
    let warga=Array.isArray(existing)?existing[0]:null;
    if(doc.warga_id&&(!warga||String(warga.id)!==String(doc.warga_id)))
      return res.status(409).json({ok:false,message:"Dokumen KTP ini sudah terhubung ke anggota keluarga lain."});
    if(warga&&String(warga.keluarga_id)!==String(doc.keluarga_id))
      return res.status(409).json({ok:false,message:"NIK ini sudah terdaftar pada keluarga lain. Periksa kemungkinan data ganda."});
    if(!warga){
      const inserted=await supabaseRequest("warga",{
        method:"POST",
        body:{
          nama_lengkap:nama,nik,no_kk:family.no_kk,jenis_kelamin:jenisKelamin,
          tempat_lahir:tempatLahir||null,tanggal_lahir:tanggalLahir||null,
          alamat:family.alamat||"",rt:family.rt||"04",rw:family.rw||"01",
          hubungan_keluarga:hubungan,keluarga_id:doc.keluarga_id,
          status_warga:"menunggu_verifikasi"
        }
      });
      warga=Array.isArray(inserted)?inserted[0]:inserted;
    }
    await supabaseRequest("dokumen_identitas",{
      method:"PATCH",query:"id=eq."+encodeURIComponent(docId),body:{warga_id:warga.id}
    });
    res.status(201).json({ok:true,message:"Anggota keluarga berhasil dicatat dan menunggu verifikasi Ketua RT.",warga:{id:warga.id,nama_lengkap:warga.nama_lengkap,nik:warga.nik}});
  }catch(error){
    console.error("DAFTARKAN ANGGOTA DARI KTP ERROR:",error);
    res.status(500).json({ok:false,message:"Gagal mencatat anggota keluarga. Periksa kemungkinan NIK sudah terdaftar."});
  }
});


app.get("/api/identitas/keluarga/:id/salinan", requireAdmin, async(req,res)=>{
  try{
    const id=String(req.params.id||"");
    if(!/^[0-9]+$/.test(id))return res.status(400).json({ok:false,message:"ID keluarga tidak valid."});
    const familyRows=await supabaseRequest("keluarga",{query:"select=id,no_kk,kepala_keluarga,alamat,rt,rw,created_at&id=eq."+encodeURIComponent(id)+"&limit=1"});
    const family=Array.isArray(familyRows)?familyRows[0]:null;
    if(!family)return res.status(404).json({ok:false,message:"Data keluarga tidak ditemukan."});
    const members=await supabaseRequest("warga",{
      query:"select=nik,nama_lengkap,jenis_kelamin,tempat_lahir,tanggal_lahir,hubungan_keluarga,status_warga&keluarga_id=eq."+encodeURIComponent(id)+"&order=created_at.asc"
    });
    const rows=Array.isArray(members)?members:[];
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`inline; filename="salinan-data-keluarga-${id}.pdf"`);
    res.setHeader("Cache-Control","private, no-store, max-age=0");
    const pdf=new PDFDocument({size:"A4",margin:48,bufferPages:true});
    pdf.pipe(res);
    pdf.fontSize(17).font("Helvetica-Bold").text("RT TBK — DATA WARGA", {align:"center"});
    pdf.moveDown(0.3);
    pdf.fontSize(13).text("SALINAN DATA KELUARGA", {align:"center"});
    pdf.moveDown(0.5);
    pdf.fontSize(9).font("Helvetica").fillColor("#7c2d12")
      .text("SALINAN ADMINISTRATIF — BUKAN DOKUMEN IDENTITAS RESMI", {align:"center"});
    pdf.fillColor("#111827").moveDown(1);
    pdf.fontSize(10).font("Helvetica-Bold").text("Identitas Keluarga");
    pdf.moveDown(0.4);
    pdf.font("Helvetica").text("Nomor KK: "+(family.no_kk||"-"));
    pdf.text("Kepala Keluarga: "+(family.kepala_keluarga||"-"));
    pdf.text("Alamat: "+(family.alamat||"-"));
    pdf.text("RT/RW: "+(family.rt||"-")+" / "+(family.rw||"-"));
    pdf.moveDown(1);
    pdf.font("Helvetica-Bold").fontSize(10).text("Daftar Anggota Keluarga ("+rows.length+")");
    pdf.moveDown(0.4);
    rows.forEach((w,index)=>{
      if(pdf.y>700)pdf.addPage();
      pdf.font("Helvetica-Bold").fontSize(9).text((index+1)+". "+(w.nama_lengkap||"-"));
      pdf.font("Helvetica").fontSize(8)
        .text("NIK: "+(w.nik||"-")+"   |   Hubungan: "+(w.hubungan_keluarga||"-"))
        .text("Jenis kelamin: "+(w.jenis_kelamin||"-")+"   |   Tempat/tanggal lahir: "+(w.tempat_lahir||"-")+" / "+(w.tanggal_lahir||"-"))
        .text("Status pendataan: "+(w.status_warga||"-"));
      pdf.moveDown(0.5);
    });
    pdf.moveDown(1);
    pdf.fontSize(8).fillColor("#64748b")
      .text("Dicetak melalui aplikasi RT TBK. Data bersumber dari database administrasi RT dan harus diperiksa kembali oleh petugas.",{align:"left"});
    pdf.end();
  }catch(error){
    console.error("CETAK SALINAN DATA KELUARGA ERROR:",error);
    if(!res.headersSent)res.status(500).json({ok:false,message:"Gagal membuat salinan data keluarga."});
    else res.end();
  }
});

app.get("/api/identitas/:id/file", requireAdmin, async (req,res) => {
  try{
    const id=String(req.params.id||"");
    if(!/^\d+$/.test(id))return res.status(400).json({ok:false,message:"ID dokumen tidak valid."});
    const rows=await supabaseRequest("dokumen_identitas",{
      query:"select=id,storage_path,nama_file,mime_type&id=eq."+encodeURIComponent(id)+"&limit=1"
    });
    const row=Array.isArray(rows)?rows[0]:null;
    if(!row)return res.status(404).json({ok:false,message:"Dokumen tidak ditemukan."});
    const signed=await buatSignedUrlIdentitas(row.storage_path);
    res.setHeader("Cache-Control","private, no-store, max-age=0");
    res.redirect(302,signed);
  }catch(error){
    console.error("BUKA DOKUMEN IDENTITAS ERROR:",error);
    res.status(503).json({ok:false,message:"Dokumen belum dapat dibuka."});
  }
});


/* DATA SAYA + ANGGOTA KELUARGA - WARGA */
app.get("/api/my-data", requireWarga, async (req, res) => {
  try {
    const data = await supabaseRequest("warga", {
      query:
       `select=id,foto_profil,keluarga_id,nik,no_kk,nama_lengkap,jenis_kelamin,tempat_lahir,tanggal_lahir,alamat,rt,rw,status_perkawinan,pekerjaan,status_hunian,no_hp,status_warga,created_at` +
        `&id=eq.${encodeURIComponent(req.session.wargaId)}` +
        `&limit=1`
    });

    const row = Array.isArray(data) ? data[0] : data;

    if (!row) {
      return res.json(null);
    }

    let anggotaKeluarga = [];

    if (row.keluarga_id) {
      const anggota = await supabaseRequest("warga", {
        query:
         `select=id,nama_lengkap,foto_profil,hubungan_keluarga,jenis_kelamin,status_warga` +
          `&keluarga_id=eq.${encodeURIComponent(row.keluarga_id)}` +
          `&order=created_at.asc`
      });

      anggotaKeluarga = Array.isArray(anggota) ? anggota : [];
    }


const fotoUrl = await buatUrlFotoPrivat(row.foto_profil);

const anggotaDenganFoto = await Promise.all(
  anggotaKeluarga.map(async (anggota) => ({
    ...anggota,
    foto_url: await buatUrlFotoPrivat(anggota.foto_profil)
  }))
);

res.json({
  ...row,
  nama: row.nama_lengkap,
  foto_url: fotoUrl,
  anggota_keluarga: anggotaDenganFoto
});

  } catch (error) {
    console.error("MY DATA ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil data warga"
    });
  }
});

/* UPDATE DATA SAYA - WARGA */
app.patch("/api/my-data", requireWarga, async (req, res) => {
  try {
    const {
  jenis_kelamin,
  tempat_lahir,
  tanggal_lahir,
  alamat,
  rt,
  rw,
  status_perkawinan,
  pekerjaan,
  status_hunian
} = req.body;

    const data = await supabaseRequest("warga", {
      method: "PATCH",
      query:
        `id=eq.${encodeURIComponent(req.session.wargaId)}`,
      body: {
        jenis_kelamin: jenis_kelamin || null,
        tempat_lahir: tempat_lahir || null,
        tanggal_lahir: tanggal_lahir || null,
        alamat: alamat || "",
        rt: rt || "04",
        rw: rw || "01",
        status_perkawinan: status_perkawinan || null,
        pekerjaan: pekerjaan || null,
        // Status hunian hanya diubah jika diisi, agar data lama tidak terhapus.
        ...(status_hunian ? { status_hunian } : {})
      }
    });

    const row = Array.isArray(data) ? data[0] : data;

    res.json({
      ok: true,
      message: "Data warga berhasil diperbarui",
      data: dataWargaAman(row)
    });

  } catch (error) {
    console.error("UPDATE MY DATA ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal menyimpan data warga"
    });
  }
});


/* KAS - KETUA RT */
app.get("/api/cash", requireFinance, async (req, res) => {
  try {
    const data = await supabaseRequest("kas_rt", {
      query:
        "select=id,tanggal,jenis,keterangan,jumlah,kategori,created_at,bukti_path&order=created_at.desc"
    });

    const infoIuran = await infoIuranUntukKas(Array.isArray(data) ? data : []);

    const rows = Array.isArray(data)
      ? data.map(row => {
          const info = infoIuran.get(iuranIdDariKeterangan(row.keterangan));
          return {
          ...row,
          nama_warga: info?.nama_warga || "",
          periode: info?.bulan || "",
          periode_label: info?.periode_label || "",
          keterangan_rapi: keteranganKasRapi(row, info),
          description: row.keterangan,
          date: row.tanggal,
          type:
            String(row.jenis || "").toLowerCase().includes("keluar")
              ? "keluar"
              : "masuk",
          amount: row.jumlah
        };
        })
      : [];

    res.json(rows);
  } catch (error) {
    console.error("CASH ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil data kas"
    });
  }
});

/* UPLOAD BUKTI PENGELUARAN - KETUA RT */
app.post(
  "/api/cash/proof",
  requireFinance,
  express.raw({
    type: ["image/jpeg", "image/png", "image/webp"],
    limit: "5mb"
  }),
  async (req, res) => {
    try {
      const contentType = String(req.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase();

      const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/webp"
      ];

      if (!allowedTypes.includes(contentType)) {
        return res.status(400).json({
          ok: false,
          message: "Format bukti harus JPG, PNG, atau WebP"
        });
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({
          ok: false,
          message: "File bukti belum diterima"
        });
      }

      const jenisBukti = detectImageType(req.body);

      if (!jenisBukti || jenisBukti.mime !== contentType) {
        return res.status(400).json({
          ok: false,
          message: "Isi file tidak sesuai dengan format gambar"
        });
      }

      const extension = jenisBukti.ext;


const buktiHash = hashBuktiPengeluaran(req.body);
const path = await uploadBuktiPengeluaran(
  `bukti.${extension}`,
  req.body,
  contentType
);

     return res.json({
  ok: true,
  message: "Bukti berhasil diunggah",
  path,
  buktiHash
});
    } catch (error) {
      console.error("UPLOAD BUKTI ERROR:", error);

      return res.status(500).json({
        ok: false,
        message: "Gagal mengunggah bukti. Periksa konfigurasi Storage."
      });
    }
  }
);


/* LIHAT BUKTI PENGELUARAN - DOMAIN APLIKASI */
app.get("/api/cash/proof/:id", requireLogin, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({ ok: false, message: "ID transaksi tidak valid" });
    }
    if (!["admin", "warga", "bendahara"].includes(req.session?.role)) {
      return res.status(403).json({ ok: false, message: "Akses ditolak" });
    }

    const data = await supabaseRequest("kas_rt", {
      query: "select=id,jenis,bukti_path" +
        `&id=eq.${encodeURIComponent(id)}&limit=1`
    });
    const row = Array.isArray(data) ? data[0] : null;
    if (!row || !row.bukti_path) {
      return res.status(404).json({ ok: false, message: "Bukti pengeluaran tidak ditemukan" });
    }
    if (req.session.role === "warga" && row.jenis !== "keluar") {
      return res.status(403).json({ ok: false, message: "Bukti transaksi ini tidak tersedia untuk akun warga" });
    }

    const filePath = String(row.bukti_path);
    if (!/^\d+-bukti\.(jpg|png|webp)$/.test(filePath)) {
      return res.status(400).json({ ok: false, message: "Lokasi bukti tidak valid" });
    }

    const storageResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/bukti-pengeluaran/${encodeURIComponent(filePath)}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );
    if (!storageResponse.ok) {
      console.error("CASH PROOF STORAGE ERROR:", storageResponse.status);
      return res.status(502).json({ ok: false, message: "Berkas bukti tidak dapat diambil dari penyimpanan" });
    }

    const bytes = Buffer.from(await storageResponse.arrayBuffer());
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) {
      return res.status(502).json({ ok: false, message: "Ukuran berkas bukti tidak valid" });
    }

    const mime = filePath.endsWith(".jpg") ? "image/jpeg"
      : filePath.endsWith(".png") ? "image/png" : "image/webp";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Content-Disposition", `inline; filename="bukti-kas-${id}.${filePath.split(".").pop()}"`);
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(bytes);
  } catch (error) {
    console.error("VIEW PROOF ERROR:", error);
    return res.status(500).json({ ok: false, message: "Gagal membuka bukti pengeluaran" });
  }
});

/* TAMBAH TRANSAKSI KAS - KETUA RT */
app.post("/api/cash", requireFinance, async (req, res) => {
  try {
    const {
      type,
      category,
      date,
      description,
      amount,
      proof
    } = req.body;

    const jenis = String(type || "").toLowerCase().trim();
    const kategori = String(category || "").trim();
    const keterangan = String(description || "").trim();
    const jumlah = Number(amount);

    if (!["masuk", "keluar"].includes(jenis)) {
      return res.status(400).json({
        ok: false,
        message: "Jenis transaksi tidak valid"
      });
    }

    if (
      !kategori ||
      !keterangan ||
      !date ||
      !Number.isFinite(jumlah) ||
      jumlah <= 0
    ) {
      return res.status(400).json({
        ok: false,
        message: "Kategori, tanggal, keterangan, dan jumlah wajib diisi"
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        ok: false,
        message: "Tanggal transaksi tidak valid"
      });
    }

    let buktiHash = null;

    if (jenis === "keluar") {
      if (
        typeof proof !== "string" ||
        !/^\d+-bukti\.(jpg|png|webp)$/.test(proof)
      ) {
        return res.status(400).json({
          ok: false,
          message: "Unggah bukti pengeluaran terlebih dahulu"
        });
      }

      // Periksa apakah lokasi bukti pernah digunakan.
      const buktiLama = await supabaseRequest("kas_rt", {
        query:
          "select=id" +
          `&bukti_path=eq.${encodeURIComponent(proof)}` +
          "&limit=1"
      });

      if (Array.isArray(buktiLama) && buktiLama.length > 0) {
        return res.status(409).json({
          ok: false,
          message:
            "Bukti pengeluaran ini sudah digunakan pada transaksi sebelumnya."
        });
      }

      // Ambil isi foto dari Supabase Storage.
      const fotoResponse = await fetch(
        `${SUPABASE_URL}/storage/v1/object/bukti-pengeluaran/${encodeURIComponent(proof)}`,
        {
          method: "GET",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`
          }
        }
      );

      if (!fotoResponse.ok) {
        console.error(
          "READ PROOF ERROR:",
          fotoResponse.status,
          await fotoResponse.text()
        );

        return res.status(400).json({
          ok: false,
          message: "Bukti foto tidak dapat dibaca. Silakan unggah ulang."
        });
      }

      const fotoBuffer = Buffer.from(
        await fotoResponse.arrayBuffer()
      );

      // Hitung hash berdasarkan isi foto, bukan nama file.
      buktiHash = hashBuktiPengeluaran(fotoBuffer);

      // Tolak foto yang identik dengan bukti transaksi sebelumnya.
      const hashLama = await supabaseRequest("kas_rt", {
        query:
          "select=id,keterangan,tanggal,jumlah" +
          `&bukti_hash=eq.${encodeURIComponent(buktiHash)}` +
          "&limit=1"
      });

      if (Array.isArray(hashLama) && hashLama.length > 0) {
        return res.status(409).json({
          ok: false,
          message:
            "Foto bukti ini sudah digunakan pada transaksi pengeluaran sebelumnya."
        });
      }
    }

    // Saldo kategori dan pencatatan transaksi dilakukan dalam satu RPC
    // atomik agar dua pengeluaran bersamaan tidak memakai saldo yang sama.
    const hasil = await supabaseRequest("rpc/record_cash_transaction", {
      method: "POST",
      body: {
        p_tanggal: date,
        p_jenis: jenis,
        p_kategori: kategori,
        p_keterangan: keterangan,
        p_jumlah: jumlah,
        p_bukti_path: jenis === "keluar" ? proof : null,
        p_bukti_hash: jenis === "keluar" ? buktiHash : null
      }
    });

    const data = Array.isArray(hasil) ? hasil[0] : hasil;

    return res.json({
      ok: true,
      message: "Transaksi berhasil disimpan",
      data: Array.isArray(data) ? data[0] : data
    });

} catch (error) {
  console.error("ADD CASH ERROR:", error);

  const pesanError = String(
    error?.message || error || ""
  );

  if (
    getSupabaseErrorCode(error) === "P0001" &&
    pesanError.includes("SALDO_KATEGORI_TIDAK_CUKUP")
  ) {
    return res.status(400).json({
      ok: false,
      message: `Saldo kategori ${String(req.body?.category || "").trim()} tidak mencukupi. Transaksi tidak disimpan.`
    });
  }

  if (
    pesanError.includes("kas_rt_bukti_hash_unik") ||
    pesanError.includes("duplicate key")
  ) {
    return res.status(409).json({
      ok: false,
      message:
        "Foto bukti ini sudah digunakan pada transaksi pengeluaran sebelumnya."
    });
  }

  return res.status(500).json({
    ok: false,
    message: "Gagal menyimpan transaksi kas"
  });
}

});


/* EXPORT KAS RT */
app.get("/api/cash/export", requireFinance, async (req, res) => {
  try {
    const data = await supabaseRequest("kas_rt", {
      query:
        "select=id,tanggal,jenis,keterangan,jumlah,kategori,bukti_path,created_at&order=created_at.desc"
    });

    const rows = Array.isArray(data) ? data : [];
    const infoIuranExport = await infoIuranUntukKas(rows);

    const header = [
      "No",
      "Tanggal",
      "Jenis",
      "Kategori",
      "Nama Warga",
      "Keterangan",
      "Jumlah (Rp)",
      "Bukti Pengeluaran",
      "Tanggal Dibuat"
    ];

    let totalMasuk = 0;
    let totalKeluar = 0;

    const saldoKategori = {
      "Keamanan": 0,
      "Sampah": 0,
      "Kas RT": 0
    };

    const csvRows = rows.map((row, index) => {
      const jumlah = Number(row.jumlah) || 0;
      const jenis = String(row.jenis || "").toLowerCase();
      const kategori = String(row.kategori || "").trim();

      if (jenis.includes("keluar")) {
        totalKeluar += jumlah;

        if (Object.prototype.hasOwnProperty.call(saldoKategori, kategori)) {
          saldoKategori[kategori] -= jumlah;
        }
      } else {
        totalMasuk += jumlah;

        if (Object.prototype.hasOwnProperty.call(saldoKategori, kategori)) {
          saldoKategori[kategori] += jumlah;
        }
      }

      return [
        index + 1,
        row.tanggal || "",
        row.jenis || "",
        kategori,
        infoIuranExport.get(iuranIdDariKeterangan(row.keterangan))?.nama_warga || "",
        keteranganKasRapi(row, infoIuranExport.get(iuranIdDariKeterangan(row.keterangan))),
        jumlah,
        row.bukti_path || "",
        row.created_at || ""
      ];
    });

    const saldoAkhir = totalMasuk - totalKeluar;

    const rekapRows = [
      [],
      ["REKAPITULASI KAS RT"],
      ["Total Pemasukan", "", "", "", "", "", totalMasuk],
      ["Total Pengeluaran", "", "", "", "", "", totalKeluar],
      ["SALDO AKHIR", "", "", "", "", "", saldoAkhir],
      [],
      ["RINCIAN SALDO DANA"],
      ["Dana Keamanan", "", "", "", "", "", saldoKategori["Keamanan"]],
      ["Dana Sampah", "", "", "", "", "", saldoKategori["Sampah"]],
      ["Dana Kas RT", "", "", "", "", "", saldoKategori["Kas RT"]]
    ];

  const csv = [
  header,
  ...csvRows
]

.map(row =>
  row.map(value =>
    csvCell(value)
  ).join(",")
)
.join("\r\n");


    res.setHeader(
      "Content-Type",
      "text/csv; charset=utf-8"
    );

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="kas-rt-kita.csv"'
    );

    res.send("﻿" + csv);

  } catch (error) {
    console.error("EXPORT KAS ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal export kas RT"
    });
  }
});


/* KAS - WARGA - TRANSPARANSI LENGKAP */
app.get("/api/cash-warga", requireWarga, async (req, res) => {
  try {
    const data = await supabaseRequest("kas_rt", {
      query:
       "select=id,tanggal,jenis,keterangan,jumlah,kategori,created_at,bukti_path&order=tanggal.desc,created_at.desc"
    });

    const rows = Array.isArray(data) ? data : [];
    const infoIuran = await infoIuranUntukKas(rows);

    const result = rows.map(row => {
      const info = infoIuran.get(iuranIdDariKeterangan(row.keterangan));
      return {
        id: row.id,
        tanggal: row.tanggal || "",
        waktu: row.created_at || "",
        bukti_path: row.bukti_path || "",
        type: row.jenis === "keluar" ? "keluar" : "masuk",
        amount: Number(row.jumlah) || 0,
        description: keteranganKasRapi(row, info),
        nama_warga: info?.nama_warga || "",
        periode: info?.periode_label || "",
        total_iuran: Number(info?.total_amount) || 0,
        status_iuran: info?.status || "",
        diverifikasi_at: info?.diverifikasi_at || "",
        diverifikasi_oleh: info?.diverifikasi_oleh || "",
        kategori: row.kategori || (info ? "Iuran Warga" : "Lainnya")
      };
    });

    res.json(result);

  } catch (error) {
    console.error("CASH WARGA ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil data transparansi kas"
    });
  }
});

/* SURAT - KETUA RT */
app.get("/api/letters", requireSecretary, async (req, res) => {
  try {
    const data = await supabaseRequest("pengajuan_surat", {
      query:
        "select=id,warga_id,jenis_surat,keperluan,status,catatan,created_at,nama_pemohon,nik_pemohon,no_kk_pemohon,alamat_pemohon,tempat_lahir_pemohon,tanggal_lahir_pemohon,jenis_kelamin_pemohon,pekerjaan_pemohon,status_perkawinan_pemohon,no_hp_pemohon,sumber_pengajuan&order=created_at.desc"
    });

    const list = Array.isArray(data) ? data : [];
    let warga = new Map();

    try {
      warga = await ambilNamaWarga(list.map(r => r.warga_id));
    } catch (err) {
      console.error("NAMA PENGAJU SURAT ERROR:", err?.message || err);
    }

    const rows = list.map(row => {
      const w = warga.get(String(row.warga_id));
      return {
        ...row,
        type: row.jenis_surat,
        purpose: row.keperluan,
        nama: w?.nama_lengkap || row.nama_pemohon || "",
        nik: w?.nik || row.nik_pemohon || "",
        alamat: w?.alamat || row.alamat_pemohon || "",
        no_hp: w?.no_hp || row.no_hp_pemohon || "",
        no_kk: w?.no_kk || row.no_kk_pemohon || "",
        tempat_lahir: w?.tempat_lahir || row.tempat_lahir_pemohon || "",
        tanggal_lahir: w?.tanggal_lahir || row.tanggal_lahir_pemohon || "",
        jenis_kelamin: w?.jenis_kelamin || row.jenis_kelamin_pemohon || "",
        pekerjaan: w?.pekerjaan || row.pekerjaan_pemohon || "",
        sumber_pengajuan: row.sumber_pengajuan || "warga"
      };
    });

    res.json(rows);
  } catch (error) {
    console.error("LETTERS ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil data surat"
    });
  }
});

/* AJUKAN SURAT DIBANTU KETUA RT — pilih Data Warga atau isi identitas sesuai KTP */
app.post("/api/letters/for-resident", requireAdmin, async (req, res) => {
  try {
    const type = String(req.body?.type || "").trim();
    const purpose = String(req.body?.purpose || "").trim();
    const wargaIdRaw = req.body?.warga_id;
    const wargaId = wargaIdRaw == null || wargaIdRaw === "" ? null : Number(wargaIdRaw);
    const manual = req.body?.mode === "manual";
    const jenisDiizinkan = [
      "Surat Pengantar",
      "Surat Keterangan Domisili",
      "Surat Keterangan Tidak Mampu",
      "Surat Keterangan Usaha",
      "Surat Pengantar SKCK"
    ];
    if (!jenisDiizinkan.includes(type) || !purpose || purpose.length > 1000) {
      return res.status(400).json({ ok: false, message: "Jenis surat dan keperluan wajib diisi dengan benar." });
    }

    let identity = {};
    if (manual) {
      const nama = String(req.body?.nama || "").trim();
      const nik = String(req.body?.nik || "").replace(/\s/g, "");
      const noKk = String(req.body?.no_kk || "").replace(/\s/g, "");
      const kkRequired = ["Surat Keterangan Domisili", "Surat Keterangan Tidak Mampu"].includes(type);
      const alamat = String(req.body?.alamat || "").trim();
      const tempatLahir = String(req.body?.tempat_lahir || "").trim();
      const tanggalLahir = String(req.body?.tanggal_lahir || "").trim();
      const jenisKelamin = String(req.body?.jenis_kelamin || "").trim();
      const pekerjaan = String(req.body?.pekerjaan || "").trim();
      const statusPerkawinan = String(req.body?.status_perkawinan || "").trim();
      const noHp = String(req.body?.no_hp || "").trim();

      if (!nama || !/^\d{16}$/.test(nik) || !alamat) {
        return res.status(400).json({ ok: false, message: "Nama, NIK 16 digit, dan alamat sesuai KTP wajib diisi." });
      }
      if (kkRequired && !/^\d{16}$/.test(noKk)) {
        return res.status(400).json({ ok: false, message: "Jenis surat ini mewajibkan nomor KK 16 digit." });
      }
      if (!kkRequired && noKk) {
        return res.status(400).json({ ok: false, message: "Nomor KK tidak diperlukan untuk jenis surat ini." });
      }
      if (tanggalLahir && !/^\d{4}-\d{2}-\d{2}$/.test(tanggalLahir)) {
        return res.status(400).json({ ok: false, message: "Format tanggal lahir tidak valid." });
      }
      identity = {
        nama_pemohon: nama,
        nik_pemohon: nik,
        no_kk_pemohon: noKk || null,
        alamat_pemohon: alamat,
        tempat_lahir_pemohon: tempatLahir || null,
        tanggal_lahir_pemohon: tanggalLahir || null,
        jenis_kelamin_pemohon: jenisKelamin || null,
        pekerjaan_pemohon: pekerjaan || null,
        status_perkawinan_pemohon: statusPerkawinan || null,
        no_hp_pemohon: noHp || null,
        sumber_pengajuan: "dibantu_rt_manual"
      };
    } else {
      if (!Number.isSafeInteger(wargaId) || wargaId <= 0) {
        return res.status(400).json({ ok: false, message: "Pilih warga dari Data Warga atau pilih pengisian manual." });
      }
      const wargaRows = await supabaseRequest("warga", {
        query: "select=id,nama_lengkap,nik,no_kk,alamat,tempat_lahir,tanggal_lahir,jenis_kelamin,pekerjaan,status_perkawinan,no_hp&id=eq." + encodeURIComponent(wargaId) + "&limit=1"
      });
      const warga = Array.isArray(wargaRows) ? wargaRows[0] : null;
      if (!warga) return res.status(404).json({ ok: false, message: "Data warga tidak ditemukan." });
      identity = {
        nama_pemohon: warga.nama_lengkap || null,
        nik_pemohon: warga.nik || null,
        no_kk_pemohon: kkRequired ? (warga.no_kk || null) : null,
        alamat_pemohon: warga.alamat || null,
        tempat_lahir_pemohon: warga.tempat_lahir || null,
        tanggal_lahir_pemohon: warga.tanggal_lahir || null,
        jenis_kelamin_pemohon: warga.jenis_kelamin || null,
        pekerjaan_pemohon: warga.pekerjaan || null,
        status_perkawinan_pemohon: warga.status_perkawinan || null,
        no_hp_pemohon: warga.no_hp || null,
        sumber_pengajuan: "dibantu_rt_data_warga"
      };
    }

    if (kkRequired && !/^\d{16}$/.test(String(identity.no_kk_pemohon || "").replace(/\s/g, ""))) {
      return res.status(400).json({ ok: false, message: "Jenis surat ini mewajibkan nomor KK 16 digit. Lengkapi nomor KK pada Data Warga atau isi manual." });
    }

    const inserted = await supabaseRequest("pengajuan_surat", {
      method: "POST",
      body: {
        warga_id: manual ? null : wargaId,
        jenis_surat: type,
        keperluan: purpose,
        status: "diajukan",
        ...identity
      }
    });
    const row = Array.isArray(inserted) ? inserted[0] : inserted;

    if (!manual && wargaId) {
      try {
        await supabaseRequest("notifikasi", {
          method: "POST",
          body: {
            penerima_peran: "warga",
            penerima_warga_id: wargaId,
            judul: "Pengajuan Surat Dibantu Ketua RT",
            pesan: "Ketua RT membantu mengajukan " + type + " atas nama Anda. Status: menunggu persetujuan.",
            jenis: "surat",
            tautan: "/",
            referensi_id: row.id,
            sudah_dibaca: false
          }
        });
      } catch (notificationError) {
        console.error("NOTIFIKASI SURAT BANTUAN ERROR:", notificationError?.message || notificationError);
      }
    }

    return res.json({
      ok: true,
      data: row,
      message: "Pengajuan surat atas nama " + (identity.nama_pemohon || "warga") + " berhasil dibuat."
    });
  } catch (error) {
    console.error("ADMIN CREATE LETTER ERROR:", error);
    return res.status(500).json({ ok: false, message: "Gagal membuat pengajuan surat untuk warga." });
  }
});

/* AJUKAN SURAT - WARGA */
app.post("/api/letters", requireWarga, async (req, res) => {
  try {
    const {
      type,
      purpose
    } = req.body;

    if (!type || !purpose) {
      return res.status(400).json({
        ok: false,
        message: "Jenis surat dan keperluan wajib diisi"
      });
    }

    const data = await supabaseRequest("pengajuan_surat", {
      method: "POST",
      body: {
        warga_id: req.session.wargaId,
        jenis_surat: type,
        keperluan: purpose,
        status: "diajukan"
      }
    });

   const row = Array.isArray(data) ? data[0] : data;

    // Notifikasi otomatis untuk Ketua RT
    try {
      await supabaseRequest("notifikasi", {
        method: "POST",
        body: {
          penerima_peran: "admin",
          judul: "Pengajuan Surat Baru",
          pesan:
            (req.session.nama ? req.session.nama + " mengajukan surat " : "Ada pengajuan surat ") +
            (row.jenis_surat || type) +
            ". Keperluan: " +
            (row.keperluan || purpose),
          jenis: "surat",
          tautan: "/admin",
          referensi_id: row.id,
          sudah_dibaca: false
        }
      });
    } catch (notificationError) {
      console.error(
        "NOTIFIKASI PENGAJUAN SURAT ERROR:",
        notificationError
      );
    }

    res.json({
      ok: true,
      data: row
    });
  } catch (error) {
    console.error("ADD LETTER ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengajukan surat"
    });
  }
});


/* === MULAI TEMPLATE SURAT RT 004 / RW 001 === */
// Data wilayah sesuai kop surat. Nama ketua bisa diisi lewat Environment
// Variables Vercel: KETUA_RT_NAMA dan KETUA_RW_NAMA (boleh dikosongkan).
const SURAT_WILAYAH = {
  rt: "004",
  rw: "001",
  perumahan: "Perumahan Taman Bali Kahuripan",
  desa: "Sukahurip",
  kecamatan: "Sukatani",
  kabupaten: "Bekasi",
  kotaTtd: "Bekasi"
};

// Label rincian tambahan yang dikirim dari form "Ajukan Surat".
// Disimpan di kolom keperluan (baris "Label: isi"), jadi database tidak perlu diubah.
const LABEL_RINCIAN_SURAT = [
  "Nama Usaha",
  "Bidang Usaha",
  "Alamat Usaha",
  "Usaha Sejak",
  "Tinggal Sejak",
  "Penghasilan per Bulan",
  "Jumlah Tanggungan"
];

function uraikanKeperluanSurat(teks) {
  const rincian = {};
  const sisa = [];

  String(teks || "").split(/\r?\n/).forEach((baris) => {
    const cocok = baris.match(/^\s*([^:]{3,40})\s*:\s*(.*)$/);
    const label = cocok
      ? LABEL_RINCIAN_SURAT.find(
          (l) => l.toLowerCase() === cocok[1].trim().toLowerCase()
        )
      : null;

    if (label) {
      if (cocok[2].trim()) rincian[label] = cocok[2].trim();
    } else if (baris.trim()) {
      sisa.push(baris.trim());
    }
  });

  return { keperluan: sisa.join(" "), rincian };
}

function kenaliJenisSurat(jenis) {
  const j = String(jenis || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (j.includes("skck")) return "skck";
  if (j.includes("tidak mampu") || j.includes("sktm")) return "sktm";
  if (j.includes("usaha") || j.includes("sku")) return "usaha";
  if (j.includes("domisili")) return "domisili";
  return "pengantar";
}

function tulisIsiSuratPdf(doc, data) {
  // Ukur dulu di dokumen bayangan; jika isi terlalu panjang, huruf diperkecil
  // sedikit agar isi + tanda tangan tetap muat dalam satu halaman bingkai.
  const BATAS_ISI = 632;
  let skala = 1;
  for (const s of [1, 0.95, 0.9, 0.86, 0.82, 0.78]) {
    skala = s;
    const bayangan = new doc.constructor({ size: "A4", margin: 55 });
    const yAkhir = tulisKontenSurat(bayangan, data, s);
    if (yAkhir <= BATAS_ISI) break;
  }
  const yAkhir = tulisKontenSurat(doc, data, skala);
  tulisTandaTanganSurat(doc, data, yAkhir);
}

function infoTanggalSurat(letter) {
  const tanggal = new Date(letter.created_at || Date.now());
  return {
    tanggalSurat: tanggal.toLocaleDateString("id-ID", {
      day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta"
    }),
    bulan: Number(tanggal.toLocaleString("en-US", { month: "numeric", timeZone: "Asia/Jakarta" })),
    tahun: tanggal.toLocaleString("en-US", { year: "numeric", timeZone: "Asia/Jakarta" })
  };
}

function tulisKontenSurat(doc, { id, letter, warga }, skala = 1) {
  const W = SURAT_WILAYAH;
  const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
  const potong = (v, max) => {
    const s = clean(v);
    return s.length > max ? s.slice(0, max - 1).trim() + "…" : s;
  };

  const X = 72;              // batas kiri isi surat
  const LEBAR = 451;         // lebar area isi surat
  const UKURAN = 11 * skala; // ukuran huruf isi
  const FONT = "Times-Roman";
  const FONT_TEBAL = "Times-Bold";

  const jenis = kenaliJenisSurat(letter.jenis_surat);
  const { keperluan: keperluanAsli, rincian } =
    uraikanKeperluanSurat(letter.keperluan);
  const keperluan = potong(keperluanAsli, 300) || "-";
  const { bulan: bulanJakarta, tahun: tahunJakarta } = infoTanggalSurat(letter);
  const romawi = ["I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII"][bulanJakarta - 1];

  const wilayahLengkap =
    `RT ${W.rt} RW ${W.rw} ${W.perumahan}, Desa ${W.desa}, ` +
    `Kecamatan ${W.kecamatan}, Kabupaten ${W.kabupaten}`;

  // ---------- Pengaturan per jenis surat ----------
  const PENGATURAN = {
    pengantar: {
      judul: "SURAT PENGANTAR",
      kode: "SP",
      pembuka: "memberikan pengantar kepada:",
      isi: [
        `Orang tersebut di atas adalah benar warga ${wilayahLengkap}, ` +
        `yang bertempat tinggal di alamat tersebut di atas.`,
        "Surat pengantar ini diberikan kepada yang bersangkutan untuk mengurus keperluan sebagai berikut:"
      ],
      setelahKeperluan:
        `Mohon kiranya Bapak/Ibu Kepala Desa ${W.desa} atau pejabat/instansi terkait ` +
        "dapat memberikan bantuan dan pelayanan sebagaimana mestinya kepada yang bersangkutan.",
      penutup: "Demikian surat pengantar ini kami buat dengan sebenarnya untuk dapat dipergunakan sebagaimana mestinya."
    },

    domisili: {
      judul: "SURAT KETERANGAN DOMISILI",
      kode: "SKD",
      pembuka: "dengan ini menerangkan bahwa:",
      tambahIdentitas: [["Status Hunian", clean(warga.status_hunian) || "-"]],
      isi: [
        `Nama tersebut di atas adalah benar warga yang bertempat tinggal / berdomisili di ` +
        `${wilayahLengkap}` +
        (rincian["Tinggal Sejak"] ? `, sejak ${potong(rincian["Tinggal Sejak"], 40)}` : "") +
        (clean(warga.status_hunian)
          ? `, dengan status hunian sebagai ${clean(warga.status_hunian).toLowerCase()}.`
          : "."),
        "Surat keterangan domisili ini diberikan kepada yang bersangkutan untuk keperluan:"
      ],
      penutup: "Demikian surat keterangan domisili ini kami buat dengan sebenarnya untuk dapat dipergunakan sebagaimana mestinya."
    },

    sktm: {
      judul: "SURAT KETERANGAN TIDAK MAMPU",
      kode: "SKTM",
      pembuka: "dengan ini menerangkan bahwa:",
      isi: [
        `Nama tersebut di atas adalah benar warga ${wilayahLengkap}. ` +
        "Berdasarkan pengamatan dan sepengetahuan kami, yang bersangkutan beserta keluarganya " +
        "tergolong keluarga kurang mampu / berpenghasilan rendah."
      ],
      rincian: [
        ["Penghasilan per Bulan", rincian["Penghasilan per Bulan"]],
        ["Jumlah Tanggungan", rincian["Jumlah Tanggungan"]]
      ],
      isiSetelahRincian:
        `Surat keterangan ini diberikan sebagai pengantar untuk pengurusan Surat Keterangan ` +
        `Tidak Mampu (SKTM) di Pemerintah Desa ${W.desa}, guna keperluan:`,
      penutup: "Demikian surat keterangan ini kami buat dengan sebenarnya untuk dapat dipergunakan sebagaimana mestinya."
    },

    usaha: {
      judul: "SURAT KETERANGAN USAHA",
      kode: "SKU",
      pembuka: "dengan ini menerangkan bahwa:",
      isi: [
        `Nama tersebut di atas adalah benar warga ${wilayahLengkap}, ` +
        "dan benar memiliki serta menjalankan usaha dengan keterangan sebagai berikut:"
      ],
      rincian: [
        ["Nama Usaha", rincian["Nama Usaha"] || "-"],
        ["Bidang Usaha", rincian["Bidang Usaha"] || "-"],
        ["Alamat Usaha", rincian["Alamat Usaha"] || "-"],
        ["Usaha Sejak", rincian["Usaha Sejak"]]
      ],
      isiSetelahRincian:
        "Sepanjang sepengetahuan kami, usaha tersebut sampai saat ini masih berjalan dan tidak " +
        "mengganggu ketertiban lingkungan. Surat keterangan ini diberikan untuk keperluan:",
      penutup: "Demikian surat keterangan usaha ini kami buat dengan sebenarnya untuk dapat dipergunakan sebagaimana mestinya."
    },

    skck: {
      judul: "SURAT PENGANTAR SKCK",
      subjudul: "Permohonan Surat Keterangan Catatan Kepolisian",
      kode: "SP-SKCK",
      pembuka: "memberikan pengantar kepada:",
      isi: [
        `Orang tersebut di atas adalah benar warga ${wilayahLengkap}. ` +
        "Sepanjang pengetahuan kami, selama bertempat tinggal di lingkungan kami yang bersangkutan " +
        "berkelakuan baik dan tidak pernah tercatat melakukan pelanggaran ketertiban maupun " +
        "perbuatan tercela di lingkungan RT.",
        "Surat pengantar ini diberikan untuk melengkapi persyaratan permohonan Surat Keterangan " +
        "Catatan Kepolisian (SKCK) pada Kepolisian Negara Republik Indonesia, guna keperluan:"
      ],
      setelahKeperluan:
        "Mohon kiranya pihak Kepolisian dapat memberikan pelayanan sebagaimana mestinya kepada yang bersangkutan.",
      penutup: "Demikian surat pengantar ini kami buat dengan sebenarnya untuk dapat dipergunakan sebagaimana mestinya."
    }
  };

  const P = PENGATURAN[jenis];

  // ---------- Helper tulis ----------
  const paragraf = (teks, opsi = {}) => {
    doc.font(opsi.tebal ? FONT_TEBAL : FONT)
      .fontSize(opsi.ukuran || UKURAN)
      .fillColor("#000000")
      .text(teks, opsi.x || X, doc.y, {
        width: opsi.lebar || LEBAR,
        align: opsi.align || "justify",
        lineGap: 2,
        indent: opsi.indent || 0
      });
  };

  const tabel = (baris, opsi = {}) => {
    const xLabel = opsi.x || X + 24;
    const xTitik = xLabel + 130;
    const xNilai = xTitik + 10;
    const lebarNilai = X + LEBAR - xNilai;

    baris
      .filter(([, nilai]) => clean(nilai))
      .forEach(([label, nilai, tebal, maks]) => {
        const y = doc.y;
        doc.font(FONT).fontSize(UKURAN);
        doc.text(label, xLabel, y, { width: 128, lineBreak: false });
        doc.text(":", xTitik, y, { width: 8, lineBreak: false });
        doc.font(tebal ? FONT_TEBAL : FONT)
          .text(potong(nilai, maks || 160), xNilai, y, { width: lebarNilai, lineGap: 1 });
        doc.y = Math.max(doc.y, y + UKURAN * 1.25) + 2 * skala;
      });
  };

  const jarak = (n) => { doc.y += n * skala; };

  // ---------- Judul & nomor ----------
  doc.y = 132;
  doc.font(FONT_TEBAL).fontSize(14).fillColor("#000000")
    .text(P.judul, X, doc.y, { width: LEBAR, align: "center", underline: true });

  if (P.subjudul) {
    doc.font(FONT).fontSize(10.5)
      .text(P.subjudul, X, doc.y + 1, { width: LEBAR, align: "center" });
  }

  const nomorSurat =
    `${String(id).padStart(3, "0")}/${P.kode}/RT.${W.rt}/RW.${W.rw}/${romawi}/${tahunJakarta}`;

  doc.font(FONT).fontSize(UKURAN)
    .text("Nomor : " + nomorSurat, X, doc.y + 2, { width: LEBAR, align: "center" });

  jarak(16);

  // ---------- Pembuka ----------
  paragraf(
    `Yang bertanda tangan di bawah ini, Ketua Rukun Tetangga (RT) ${W.rt} Rukun Warga (RW) ${W.rw} ` +
    `${W.perumahan}, Desa ${W.desa}, Kecamatan ${W.kecamatan}, Kabupaten ${W.kabupaten}, ` +
    P.pembuka,
    { indent: 28 }
  );
  jarak(8);

  // ---------- Identitas warga ----------
  const tglLahir = warga.tanggal_lahir
    ? new Date(String(warga.tanggal_lahir).slice(0, 10) + "T00:00:00Z")
        .toLocaleDateString("id-ID", {
          day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
        })
    : "";

  let alamat = clean(warga.alamat);
  const alamatKecil = alamat.toLowerCase();
  const tambahanAlamat = [];
  if (!/\brt\b/.test(alamatKecil)) tambahanAlamat.push(`RT ${W.rt} / RW ${W.rw}`);
  if (!alamatKecil.includes("kahuripan")) tambahanAlamat.push(W.perumahan);
  if (!alamatKecil.includes("sukahurip")) {
    tambahanAlamat.push(`Desa ${W.desa}, Kec. ${W.kecamatan}, Kab. ${W.kabupaten}`);
  }
  alamat = [alamat, ...tambahanAlamat].filter(Boolean).join(", ");

  tabel([
    ["Nama Lengkap", clean(warga.nama_lengkap).toUpperCase() || "-", true],
    ["NIK", clean(warga.nik) || "-"],
    ["Nomor KK", clean(warga.no_kk) || "-"],
    ["Tempat, Tgl. Lahir", [clean(warga.tempat_lahir), tglLahir].filter(Boolean).join(", ") || "-"],
    ["Jenis Kelamin", clean(warga.jenis_kelamin) || "-"],
    ["Status Perkawinan", clean(warga.status_perkawinan) || "-"],
    ["Pekerjaan", clean(warga.pekerjaan) || "-"],
    ["Kewarganegaraan", "Indonesia"],
    ...(P.tambahIdentitas || []),
    ["Alamat", alamat || "-", false, 240]
  ]);
  jarak(8);

  // ---------- Isi sesuai jenis surat ----------
  P.isi.forEach((teks, i) => {
    paragraf(teks, { indent: 28 });
    if (i < P.isi.length - 1) jarak(5);
  });

  if (P.rincian) {
    jarak(6);
    tabel(P.rincian);
    jarak(6);
    paragraf(P.isiSetelahRincian, { indent: 28 });
  }

  // Keperluan dicetak tebal agar mudah dibaca petugas.
  jarak(6);
  paragraf(keperluan, { tebal: true, x: X + 24, lebar: LEBAR - 24, align: "left" });

  if (P.setelahKeperluan) {
    jarak(6);
    paragraf(P.setelahKeperluan, { indent: 28 });
  }

  jarak(6);
  paragraf(P.penutup, { indent: 28 });

  return doc.y;
}

// CAP TESTING: cap stempel RT digambar otomatis (vektor).
// Untuk memakai cap asli, unggah file "cap-rt.png" (latar transparan) ke repo,
// maka cap testing ini otomatis diganti dengan gambar cap asli.
function gambarCapRT(doc, cx, cy, r) {
  const W = SURAT_WILAYAH;
  const WARNA = "#1F3A93";
  const teksKeliling =
    `RT ${W.rt} / RW ${W.rw} • DESA ${W.desa.toUpperCase()} • ` +
    `KAB. ${W.kabupaten.toUpperCase()} • `;

  doc.save();
  doc.translate(cx, cy).rotate(-12);
  doc.fillOpacity(0.85).strokeOpacity(0.85);
  doc.strokeColor(WARNA).fillColor(WARNA);

  doc.lineWidth(1.8).circle(0, 0, r).stroke();
  doc.lineWidth(0.6).circle(0, 0, r - 3.2).stroke();
  doc.lineWidth(0.9).circle(0, 0, r * 0.6).stroke();

  // Teks melingkar di pita cap
  const fs = r * 0.13;
  doc.font("Helvetica-Bold").fontSize(fs);
  const lebar = [...teksKeliling].map((c) => doc.widthOfString(c));
  const total = lebar.reduce((x, y) => x + y, 0);
  const rTeks = ((r - 3.2) + r * 0.6) / 2 - fs * 0.35;
  let jalan = 0;
  [...teksKeliling].forEach((c, i) => {
    const sudut = ((jalan + lebar[i] / 2) / total) * 360;
    jalan += lebar[i];
    const rad = (sudut * Math.PI) / 180;
    doc.save();
    doc.translate(rTeks * Math.sin(rad), -rTeks * Math.cos(rad)).rotate(sudut);
    doc.text(c, -lebar[i] / 2, -fs / 2, { lineBreak: false });
    doc.restore();
  });

  // Isi tengah cap
  const lebarTengah = r * 1.1;
  doc.font("Helvetica-Bold").fontSize(r * 0.14)
    .text("KETUA RT", -lebarTengah / 2, -r * 0.33, { width: lebarTengah, align: "center", lineBreak: false });
  doc.fontSize(r * 0.3)
    .text(W.rt, -lebarTengah / 2, -r * 0.17, { width: lebarTengah, align: "center", lineBreak: false });
  // Penanda cap sementara (testing). Hilang otomatis setelah file cap-rt.png diunggah.
  doc.font("Helvetica-Bold").fontSize(r * 0.13)
    .text("UJI COBA", -lebarTengah / 2, r * 0.2, { width: lebarTengah, align: "center", lineBreak: false });

  doc.restore();
  doc.fillOpacity(1).strokeOpacity(1).fillColor("#000000").strokeColor("#000000");
}

function kodeVerifikasiSurat(id, letter) {
  const crypto = require("crypto");
  const kunci = process.env.SESSION_SECRET;
  if (!kunci) throw new Error("SESSION_SECRET belum dikonfigurasi");
  const hex = crypto
    .createHmac("sha256", kunci)
    .update(`surat:${id}:${letter.created_at || ""}:${letter.jenis_surat || ""}`)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
  return `RT004-${hex.slice(0, 5)}-${hex.slice(5)}`;
}

function tulisTandaTanganSurat(doc, { id, letter }, yAkhir) {
  const fs = require("fs");
  const path = require("path");
  const W = SURAT_WILAYAH;
  const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
  const X = 72;
  const LEBAR = 451;
  const UKURAN = 11;
  const FONT = "Times-Roman";
  const FONT_TEBAL = "Times-Bold";
  const { tanggalSurat } = infoTanggalSurat(letter);

  // ---------- Tanda tangan ----------
  const namaRT = clean(process.env.KETUA_RT_NAMA);
  const namaRW = clean(process.env.KETUA_RW_NAMA);
  const garisNama = "(.......................................)";

  const yTtd = Math.min(yAkhir + 18, 652);
  const lebarTtd = 200;
  const xKiri = X;
  const xKanan = X + LEBAR - lebarTtd;
  const ruangTtd = 62;
  const yNama = yTtd + 15 + ruangTtd;

  doc.font(FONT).fontSize(UKURAN).fillColor("#000000");

  // Kanan: Ketua RT
  doc.text(`${W.kotaTtd}, ${tanggalSurat}`, xKanan, yTtd, { width: lebarTtd, align: "center" });
  doc.text(`Ketua RT ${W.rt} / RW ${W.rw}`, xKanan, yTtd + 15, { width: lebarTtd, align: "center" });

  // Tanda tangan otomatis: pakai gambar ttd-ketua-rt.png bila ada di repo.
  const fileTtd = path.join(__dirname, "ttd-ketua-rt.png");
  if (fs.existsSync(fileTtd)) {
    try {
      doc.image(fileTtd, xKanan + lebarTtd / 2 - 55, yTtd + 30, { fit: [130, 48], align: "center", valign: "center" });
    } catch (e) {
      console.error("GAMBAR TTD KETUA RT GAGAL DIMUAT:", e?.message || e);
    }
  }

  // Gunakan hanya gambar cap RT asli jika berkas resmi tersedia.
  const fileCap = path.join(__dirname, "cap-rt.png");
  let capAsliTerpasang = false;
  if (fs.existsSync(fileCap)) {
    try {
      doc.save();
      doc.opacity(0.9);
      doc.image(fileCap, xKanan + lebarTtd / 2 - 84, yTtd + 18, { fit: [80, 80], align: "center", valign: "center" });
      doc.restore();
      capAsliTerpasang = true;
    } catch (e) {
      doc.restore();
      console.error("GAMBAR CAP RT GAGAL DIMUAT:", e?.message || e);
    }
  }
  if (!capAsliTerpasang) {
    console.warn("CAP RT RESMI BELUM TERSEDIA; PDF DIBUAT TANPA CAP.");
  }

  doc.font(namaRT ? FONT_TEBAL : FONT).fontSize(UKURAN).fillColor("#000000")
    .text(namaRT ? namaRT.toUpperCase() : garisNama, xKanan, yNama, {
      width: lebarTtd,
      align: "center",
      underline: Boolean(namaRT)
    });

  doc.font("Helvetica-Oblique").fontSize(6.5).fillColor("#444444")
    .text("Tanda tangan manual Ketua RT tetap diperlukan", xKanan, yNama + 15, { width: lebarTtd, align: "center" })
    .text("Kode verifikasi aplikasi: " + kodeVerifikasiSurat(id, letter), xKanan, yNama + 23, { width: lebarTtd, align: "center" });
  doc.fillColor("#000000");

  // Kiri: Mengetahui Ketua RW
  doc.font(FONT).fontSize(UKURAN)
    .text("Mengetahui,", xKiri, yTtd, { width: lebarTtd, align: "center" });
  doc.text(`Ketua RW ${W.rw}`, xKiri, yTtd + 15, { width: lebarTtd, align: "center" });
  doc.font(namaRW ? FONT_TEBAL : FONT)
    .text(namaRW ? namaRW.toUpperCase() : garisNama, xKiri, yNama, {
      width: lebarTtd,
      align: "center",
      underline: Boolean(namaRW)
    });
}
/* === AKHIR TEMPLATE SURAT RT 004 / RW 001 === */

/* UNDUH PDF SURAT - WARGA DAN KETUA RT */
app.get("/api/my-letters/:id/pdf", requireLogin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const isAdmin = req.session.role === "admin";
    const wargaId = req.session.wargaId;

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        message: "ID surat tidak valid"
      });
    }

        // Surat diambil berdasarkan ID; akses warga dibatasi ke pemiliknya.
    const letters = await supabaseRequest("pengajuan_surat", {
      query:
        "select=id,warga_id,jenis_surat,keperluan,status,catatan,created_at,nama_pemohon,nik_pemohon,no_kk_pemohon,alamat_pemohon,tempat_lahir_pemohon,tanggal_lahir_pemohon,jenis_kelamin_pemohon,pekerjaan_pemohon,status_perkawinan_pemohon" +
        "&id=eq." + encodeURIComponent(id) +
        (isAdmin
          ? ""
          : "&warga_id=eq." + encodeURIComponent(wargaId))
    });

    if (!Array.isArray(letters) || letters.length === 0) {
      return res.status(404).json({
        ok: false,
        message: "Surat tidak ditemukan atau bukan milik Anda"
      });
    }

    const letter = letters[0];

    if (letter.status !== "disetujui") {
      return res.status(403).json({
        ok: false,
        message: "PDF hanya tersedia setelah surat disetujui Ketua RT"
      });
    }


    // Ambil data pemilik surat yang dipilih.
    let warga = null;
    if (letter.warga_id) {
      const residents = await supabaseRequest("warga", {
        query:
          "select=id,nama_lengkap,nik,no_kk,alamat,rt,rw,jenis_kelamin,tempat_lahir,tanggal_lahir,status_perkawinan,pekerjaan,status_hunian" +
          "&id=eq." + encodeURIComponent(letter.warga_id)
      });
      if (Array.isArray(residents) && residents.length) warga = residents[0];
    }
    // Pengajuan manual menyimpan snapshot identitas sesuai KTP agar PDF tetap dapat dibuat
    // tanpa membuat atau mengubah baris Data Warga.
    warga = {
      ...(warga || {}),
      nama_lengkap: warga?.nama_lengkap || letter.nama_pemohon || "",
      nik: warga?.nik || letter.nik_pemohon || "",
      no_kk: warga?.no_kk || letter.no_kk_pemohon || "",
      alamat: warga?.alamat || letter.alamat_pemohon || "",
      tempat_lahir: warga?.tempat_lahir || letter.tempat_lahir_pemohon || "",
      tanggal_lahir: warga?.tanggal_lahir || letter.tanggal_lahir_pemohon || "",
      jenis_kelamin: warga?.jenis_kelamin || letter.jenis_kelamin_pemohon || "",
      pekerjaan: warga?.pekerjaan || letter.pekerjaan_pemohon || "",
      status_perkawinan: warga?.status_perkawinan || letter.status_perkawinan_pemohon || ""
    };
    if (!warga.nama_lengkap) {
      return res.status(404).json({ ok: false, message: "Identitas pemohon surat tidak ditemukan." });
    }
    const clean = (value) =>
      value == null ? "" : String(value).trim();
    const PDFDocument = require("pdfkit");

    const fs = require("fs");
    const path = require("path");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="surat-${id}.pdf"`
    );

    const doc = new PDFDocument({
      size: "A4",
      margin: 48
    });

    doc.pipe(res);

    // Kop surat A4: lambang Kabupaten Bekasi di kiri dan logo perumahan di kanan.
    const logoKopPath = path.join(__dirname, "images.png");
    const pakaiLogoPerumahan = fs.existsSync(logoKopPath);
    const KIRI_KOP = 48;
    const KANAN_KOP = 48;
    const LEBAR_KOP = doc.page.width - KIRI_KOP - KANAN_KOP;
    // Samakan ukuran kop Menu Surat dengan kop Aspirasi Warga.
    const UKURAN_LOGO_SISI = 92;
    const X_LOGO_KANAN = doc.page.width - KANAN_KOP - UKURAN_LOGO_SISI;
    const X_TEKS_KOP = KIRI_KOP + UKURAN_LOGO_SISI + 10;
    const LEBAR_TEKS_KOP = X_LOGO_KANAN - 10 - X_TEKS_KOP;
    const URL_LAMBANG_KABUPATEN =
      "https://upload.wikimedia.org/wikipedia/commons/1/12/Logo_Kabupaten_Bekasi.jpg";

    // Ambil lambang dari Wikimedia Commons (sumber mencantumkan Pemkab Bekasi).
    // Jika layanan gambar sedang tidak tersedia, kop surat tetap dapat dibuat.
    let lambangKabupatenBekasi = null;
    try {
      // Batasi waktu sumber gambar eksternal. PDF tetap dibuat dengan kop tanpa lambang
      // bila Wikimedia lambat/tidak tersedia; unduhan warga tidak boleh menggantung.
      const responsLambang = await fetch(URL_LAMBANG_KABUPATEN, {
        signal: AbortSignal.timeout(3000)
      });
      if (responsLambang.ok) {
        const tipeGambar = responsLambang.headers.get("content-type") || "";
        if (tipeGambar.startsWith("image/")) {
          const bytesLambang = Buffer.from(await responsLambang.arrayBuffer());
          if (bytesLambang.length > 0 && bytesLambang.length < 3 * 1024 * 1024) {
            lambangKabupatenBekasi = bytesLambang;
          }
        }
      }
    } catch (errorLambang) {
      console.warn("LAMBANG KABUPATEN BEKASI TIDAK DAPAT DIMUAT:", errorLambang.message);
    }

    if (lambangKabupatenBekasi) {
      doc.image(lambangKabupatenBekasi, KIRI_KOP, 14, {
        fit: [UKURAN_LOGO_SISI, UKURAN_LOGO_SISI],
        align: "center",
        valign: "center"
      });
    }

    if (pakaiLogoPerumahan) {
      // Bingkai rapi untuk logo asli Taman Bali Kahuripan.
      doc.save();
      doc.lineWidth(0.9).roundedRect(
        X_LOGO_KANAN, 14, UKURAN_LOGO_SISI, UKURAN_LOGO_SISI, 7
      ).fillAndStroke("#FFFFFF", "#222222");
      // Gambar satu kali agar logo tetap tajam dan tidak tampak menebal.
      doc.image(logoKopPath, X_LOGO_KANAN + 6, 20, {
        fit: [UKURAN_LOGO_SISI - 12, UKURAN_LOGO_SISI - 12],
        align: "center",
        valign: "center"
      });
      doc.restore();
    }

    doc.save();
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(17)
      .text("SEKRETARIAT", X_TEKS_KOP, 17, {
        width: LEBAR_TEKS_KOP, align: "center"
      });
    doc.font("Helvetica-Bold").fontSize(12)
      .text("PENGURUS RT 004 / RW 01", X_TEKS_KOP, 42, {
        width: LEBAR_TEKS_KOP, align: "center"
      });
    doc.font("Helvetica-Bold").fontSize(10)
      .text("Perumahan Taman Bali Kahuripan", X_TEKS_KOP, 64, {
        width: LEBAR_TEKS_KOP, align: "center"
      });
    doc.font("Helvetica-Bold").fontSize(9)
      .text("Desa Sukahurip · Kecamatan Sukatani · Kabupaten Bekasi", X_TEKS_KOP, 85, {
        width: LEBAR_TEKS_KOP, align: "center"
      });
    doc.moveTo(KIRI_KOP, 130)
      .lineTo(doc.page.width - KANAN_KOP, 130)
      .lineWidth(2.2)
      .strokeColor("#111111")
      .stroke();
    doc.restore();

    // Isi surat tetap mengikuti jenis surat dan data pengajuan yang disetujui.
    tulisIsiSuratPdf(doc, { id, letter, warga });

    doc.end();

} catch (error) {
  console.error("DOWNLOAD LETTER PDF ERROR:", error);

  if (res.headersSent) {
    if (!res.destroyed && !res.writableEnded) {
      res.destroy();
    }
    return;
  }

  return res.status(500).json({
    ok: false,
    message: "Gagal membuat PDF surat"
  });
}
});

/* SURAT SAYA - WARGA */
app.get("/api/my-letters", requireWarga, async (req, res) => {
  try {
    const data = await supabaseRequest("pengajuan_surat", {
      query:
        "select=id,warga_id,jenis_surat,keperluan,status,catatan,created_at" +
        "&warga_id=eq." +
        encodeURIComponent(req.session.wargaId) +
        "&order=created_at.desc"
    });

    const rows = Array.isArray(data)
      ? data.map(row => ({
          ...row,
          type: row.jenis_surat,
          purpose: row.keperluan
        }))
      : [];

    res.json(rows);
  } catch (error) {
    console.error("MY LETTERS ERROR:", error);
    res.status(500).json({
      ok: false,
      message: "Gagal mengambil daftar surat saya"
    });
  }
});

/* PROSES SURAT - KETUA RT */
app.patch("/api/letters/:id", requireSecretary, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, catatan = "" } = req.body;

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        message: "ID surat tidak valid"
      });
    }

    if (!["disetujui", "ditolak"].includes(status)) {
      return res.status(400).json({
        ok: false,
        message: "Status surat tidak valid"
      });
    }

    const existing = await supabaseRequest("pengajuan_surat", {
      query: `select=id,status,warga_id,jenis_surat,keperluan&id=eq.${id}`
    });

    if (!Array.isArray(existing) || existing.length === 0) {
      return res.status(404).json({
        ok: false,
        message: "Pengajuan surat tidak ditemukan"
      });
    }

    if (existing[0].status !== "diajukan") {
      return res.status(409).json({
        ok: false,
        message: "Surat ini sudah diproses sebelumnya"
      });
    }

    const updated = await supabaseRequest("pengajuan_surat", {
      method: "PATCH",
      query: `id=eq.${id}&status=eq.diajukan`,
      body: {
        status,
        catatan: String(catatan).trim()
      }
    });

    if (!Array.isArray(updated) || updated.length === 0) {
      return res.status(409).json({
        ok: false,
        message: "Status surat berubah. Muat ulang daftar surat."
      });
    }

    // Kirim pemberitahuan ke akun warga dan hubungkan ke menu Surat Saya.
    let notifikasiWargaTerkirim = false;
    try {
      const pengajuan = existing[0];
      if (pengajuan.warga_id) {
        await supabaseRequest("notifikasi", {
          method: "POST",
          body: {
            penerima_peran: "warga",
            penerima_warga_id: Number(pengajuan.warga_id),
            judul: status === "disetujui" ? "Pengajuan Surat Disetujui" : "Pengajuan Surat Ditolak",
            pesan: `Pengajuan ${pengajuan.jenis_surat || "surat"} Anda telah ${status === "disetujui" ? "disetujui" : "ditolak"} oleh Ketua RT.` +
              (String(catatan || "").trim() ? " Catatan: " + String(catatan).trim() : ""),
            jenis: "surat",
            tautan: "/",
            referensi_id: id,
            sudah_dibaca: false
          }
        });
        notifikasiWargaTerkirim = true;
      }
    } catch (notificationError) {
      console.error("NOTIFIKASI HASIL SURAT KE WARGA ERROR:", notificationError);
    }

    res.json({
      ok: true,
      notifikasi_warga_terkirim: notifikasiWargaTerkirim,
      message: status === "disetujui"
        ? (notifikasiWargaTerkirim ? "Surat disetujui dan notifikasi warga dikirim" : "Surat disetujui, tetapi notifikasi warga gagal dikirim")
        : (notifikasiWargaTerkirim ? "Surat ditolak dan notifikasi warga dikirim" : "Surat ditolak, tetapi notifikasi warga gagal dikirim"),
      data: updated[0]
    });
  } catch (error) {
    console.error("PROSES SURAT ERROR:", error);
    res.status(500).json({
      ok: false,
      message: "Gagal memproses pengajuan surat"
    });
  }
});

/* PENGUMUMAN - SEMUA YANG LOGIN */
app.get("/api/announcements", requireLogin, async (req, res) => {
  try {
    const data = await supabaseRequest("pengumuman", {
      query:
        "select=id,judul,isi,tanggal&order=tanggal.desc"
    });

    const rows = Array.isArray(data)
      ? data.map(row => ({
          ...row,
          title: row.judul,
          content: row.isi,
          created_at: row.tanggal
        }))
      : [];

    res.json(rows);
  } catch (error) {
    console.error("ANNOUNCEMENTS ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil pengumuman"
    });
  }
});

/* TAMBAH PENGUMUMAN */
app.post("/api/announcements", requireSecretary, async (req, res) => {
  try {
    const {
      title,
      content
    } = req.body;

    const data = await supabaseRequest("pengumuman", {
      method: "POST",
      body: {
        judul: title || "",
        isi: content || "",
        tanggal: new Date().toISOString()
      }
    });

    const row = Array.isArray(data) ? data[0] : data;

    res.json({
      ok: true,
      data: row
    });
  } catch (error) {
    console.error("ADD ANNOUNCEMENT ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal menyimpan pengumuman"
    });
  }
});

/* PENGADUAN - KETUA RT */
app.get("/api/complaints", requireAdmin, async (req, res) => {
  try {
    const data = await supabaseRequest("notifikasi", {
      query:
        "select=id,judul,pesan,referensi_id,sudah_dibaca,dibuat_pada" +
        "&penerima_peran=eq.admin&jenis=eq.pengaduan" +
        "&order=dibuat_pada.desc&limit=500"
    });

    const rows = Array.isArray(data) ? data : [];
    const ids = [...new Set(
      rows
        .map(r => String(r.referensi_id ?? "").trim())
        .filter(id => /^[0-9]+$/.test(id))
    )];
    const namaMap = new Map();

    if (ids.length) {
      const warga = await supabaseRequest("warga", {
        query: `select=id,nama_lengkap&id=in.(${ids.join(",")})`
      });
      (Array.isArray(warga) ? warga : []).forEach(w =>
        namaMap.set(String(w.id), w.nama_lengkap || "")
      );
    }

    return res.json(rows.map(r => ({
      id: r.id,
      warga_id: r.referensi_id,
      title: r.judul,
      content: r.pesan,
      nama: namaMap.get(String(r.referensi_id)) || "",
      created_at: r.dibuat_pada,
      status: r.sudah_dibaca ? "dibaca" : "baru"
    })));
  } catch (error) {
    console.error("PENGADUAN GET ERROR:", error?.message || error);
    return res.status(503).json({
      ok: false,
      message: "Pengaduan belum dapat dimuat dari database. Silakan coba kembali."
    });
  }
});

/* PENGADUAN - WARGA */
/* RIWAYAT PENGADUAN — WARGA */

app.get("/api/my-complaints", requireWarga, async (req, res) => {
  try {
    if (!req.session?.wargaId) {
      return res.status(403).json({ ok: false, message: "Identitas warga tidak ditemukan" });
    }
    const data = await supabaseRequest("notifikasi", {
      query:
        "select=id,judul,pesan,sudah_dibaca,dibuat_pada" +
        "&penerima_peran=eq.admin&jenis=eq.pengaduan" +
        "&referensi_id=eq." + encodeURIComponent(req.session.wargaId) +
        "&order=dibuat_pada.desc&limit=100"
    });
    return res.json((Array.isArray(data) ? data : []).map(row => ({
      id: row.id,
      title: row.judul || "",
      content: row.pesan || "",
      sudah_dibaca: row.sudah_dibaca === true,
      created_at: row.dibuat_pada || null
    })));
  } catch (error) {
    console.error("RIWAYAT PENGADUAN ERROR:", error?.message || error);
    return res.status(503).json({ ok: false, message: "Riwayat pengaduan belum dapat dimuat. Silakan coba kembali." });
  }
});

app.post("/api/complaints", requireWarga, async (req, res) => {
  const title = String(req.body?.title || "").trim();
  const content = String(req.body?.content || "").trim();

  if (!title || !content) {
    return res.status(400).json({
      ok: false,
      message: "Judul dan isi pengaduan wajib diisi"
    });
  }

  try {
    const data = await supabaseRequest("notifikasi", {
      method: "POST",
      body: {
        penerima_peran: "admin",
        judul: title.slice(0, 200),
        pesan: content.slice(0, 2000),
        jenis: "pengaduan",
        tautan: "/admin",
        referensi_id: Number(req.session.wargaId),
        sudah_dibaca: false
      }
    });

    return res.json({
      ok: true,
      data: Array.isArray(data) ? data[0] : data
    });
  } catch (error) {
    console.error("PENGADUAN SIMPAN ERROR:", error?.message || error);
    return res.status(503).json({
      ok: false,
      message: "Pengaduan belum dapat dipastikan tersimpan. Periksa daftar pengaduan sebelum mengirim ulang."
    });
  }
});


/* IURAN WARGA */
app.get("/api/my-iuran", requireWarga, async (req, res) => {
  try {
    const wargaData = await supabaseRequest("warga", {
      query:
        "select=id,keluarga_id" +
        `&id=eq.${encodeURIComponent(req.session.wargaId)}` +
        "&limit=1"
    });

    const warga = Array.isArray(wargaData) ? wargaData[0] : null;

    if (!warga || !warga.keluarga_id) {
      return res.status(400).json({
        ok: false,
        message: "Data keluarga belum terhubung. Hubungi Ketua RT."
      });
    }

    const data = await supabaseRequest("iuran_warga", {
      query:
       "select=id,warga_id,keluarga_id,bulan,status,total_amount,bukti_transfer,midtrans_notifikasi_at" +
        `&keluarga_id=eq.${encodeURIComponent(String(warga.keluarga_id))}` +
        "&order=bulan.desc"
    });

    const rows = Array.isArray(data) ? data : [];

    // Tandai transaksi yang dipastikan kedaluwarsa oleh Midtrans.
    for (const row of rows) {
      row.transaksi_kedaluwarsa = false;

      if (
        row.status !== "lunas" &&
        String(row.bukti_transfer || "").startsWith("MIDTRANS:")
      ) {
        try {
          const orderId = String(row.bukti_transfer).slice("MIDTRANS:".length);
          const serverKey = getMidtransServerKeyForOrder(orderId);

          if (!serverKey) {
            continue;
          }

          const cek = await fetch(
            `${getMidtransApiBaseForOrder(orderId)}/v2/${encodeURIComponent(orderId)}/status`,
            {
              headers: {
                Authorization:
                  "Basic " +
                  Buffer.from(serverKey + ":").toString("base64")
              }
            }
          );

          if (cek.ok) {
            const transaksi = await cek.json();
            row.transaksi_kedaluwarsa = [
              "expire",
              "cancel",
              "deny"
            ].includes(transaksi.transaction_status);
          }
        } catch (err) {
          console.error(
            "CEK STATUS MIDTRANS ERROR:",
            err?.message || err
          );
        }
      }
    }

    return res.json(rows);
  } catch (error) {
    console.error("MY IURAN ERROR:", error);

    return res.status(500).json({
      ok: false,
      message: "Gagal mengambil data iuran"
    });
  }
});


app.get("/api/iuran", requireFinance, async (req, res) => {
  try {
    const data = await supabaseRequest("iuran_warga", {
      query: "select=*&order=bulan.desc"
    });

    const rows = Array.isArray(data) ? data : [];

    // Tambahkan nama warga agar Ketua RT tidak hanya melihat ID.
    const ids = [...new Set(
      rows
        .map(r => String(r.warga_id || "").trim())
        .filter(id => /^[A-Za-z0-9-]+$/.test(id))
    )];

    const namaMap = new Map();

    if (ids.length) {
      try {
        const warga = await supabaseRequest("warga", {
          query:
            "select=id,nama_lengkap" +
            `&id=in.(${ids.map(encodeURIComponent).join(",")})`
        });

        (Array.isArray(warga) ? warga : []).forEach(w => {
          namaMap.set(String(w.id), w.nama_lengkap || "");
        });
      } catch (err) {
        console.error("IURAN NAMA WARGA ERROR:", err?.message || err);
      }
    }

    res.json(rows.map(r => ({
      ...r,
      nama_warga: namaMap.get(String(r.warga_id)) || ""
    })));
  } catch (error) {
    console.error("IURAN ERROR:", error);
    res.status(500).json({
      ok: false,
      message: "Gagal mengambil data iuran"
    });
  }
});



/* SETORAN QRIS KETUA GANG ATAS NAMA WARGA */
app.post("/api/ketua-gang/setor-qris", requireGangLead, async (req, res) => {
  let orderId = null;
  let rowsTersimpan = [];
  try {
    const wargaId = String(req.body?.warga_id || "").trim();
    const bulan = String(req.body?.bulan || "").trim();
    if (!/^\d+$/.test(wargaId) || !isValidIuranMonth(bulan)) {
      return res.status(400).json({ ok: false, message: "Pilih warga dan bulan iuran yang valid." });
    }

    const gangPetugas = String(req.session.gang || "").trim();
    if (!gangPetugas) {
      return res.status(403).json({ ok: false, message: "Wilayah gang akun Ketua Gang belum ditetapkan." });
    }

    const wargaRows = await supabaseRequest("warga", {
      query: "select=id,nama_lengkap,keluarga_id,gang,status_warga&id=eq." +
        encodeURIComponent(wargaId) + "&limit=1"
    });
    const warga = Array.isArray(wargaRows) ? wargaRows[0] : null;
    if (!warga || String(warga.gang || "").trim().toLowerCase() !== gangPetugas.toLowerCase()) {
      return res.status(403).json({ ok: false, message: "Warga tersebut bukan bagian dari gang tugas Anda." });
    }
    if (warga.status_warga !== "aktif" || !warga.keluarga_id) {
      return res.status(400).json({ ok: false, message: "Warga belum aktif atau data keluarganya belum lengkap." });
    }

    const keluargaId = String(warga.keluarga_id);
    const dataIuran = await supabaseRequest("iuran_warga", {
      query: "select=id,bulan,status,total_amount,bukti_transfer&keluarga_id=eq." +
        encodeURIComponent(keluargaId) + "&order=bulan.asc"
    });
    const catatan = Array.isArray(dataIuran) ? dataIuran : [];
    const peta = new Map(catatan.map(row => [String(row.bulan || "").slice(0, 7), row]));
    const akhir = new Date(Number(bulan.slice(0, 4)), Number(bulan.slice(5, 7)) - 1, 1);
    for (let d = new Date(2026, 9, 1); d < akhir; d.setMonth(d.getMonth() + 1)) {
      const periode = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      if (peta.get(periode)?.status !== "lunas") {
        return res.status(409).json({ ok: false, message: "Iuran " + periode + " harus diselesaikan lebih dahulu." });
      }
    }
    const lama = peta.get(bulan);
    if (lama) {
      return res.status(409).json({
        ok: false,
        message: lama.status === "lunas"
          ? "Iuran bulan ini sudah lunas."
          : "Sudah ada transaksi untuk bulan ini. Minta Bendahara memeriksa statusnya sebelum membuat QRIS baru."
      });
    }

    const total = 35000;
    orderId = (getMidtransModeInfo().mode === "production" ? "RTTBK-PROD-" : "RTTBK-SBX-") +
      Date.now() + "-" + crypto.randomBytes(4).toString("hex");
    const penyetorNama = String(req.session.nama || req.session.username || "Ketua Gang");
    const transaksi = await buatTransaksiQRIS({ orderId, total, namaWarga: warga.nama_lengkap, namaPembayar: penyetorNama });

    const penyetorId = Number(req.session.id);
    const hasilReserva = await supabaseRequest("rpc/reserve_qris_iuran_batch_with_attribution", {
      method: "POST",
      body: {
        p_warga_id: String(warga.id),
        p_keluarga_id: keluargaId,
        p_bulans: [bulan + "-01"],
        p_replace_ids: [],
        p_order_id: orderId,
        p_disetorkan_oleh_id: penyetorId,
        p_disetorkan_oleh_nama: penyetorNama
      }
    });
    rowsTersimpan = Array.isArray(hasilReserva) ? hasilReserva : [];
    if (rowsTersimpan.length !== 1 || rowsTersimpan[0].bukti_transfer !== "MIDTRANS:" + orderId ||
        rowsTersimpan[0].jalur_pembayaran !== "ketua_gang_qris" ||
        Number(rowsTersimpan[0].disetorkan_oleh_id) !== penyetorId) {
      throw new Error("Reservasi iuran QRIS dan atribusi penyetor tidak lengkap atau tidak cocok dengan order.");
    }

    try {
      await supabaseRequest("notifikasi", {
        method: "POST",
        body: {
          penerima_peran: "admin",
          judul: "Setoran QRIS Ketua Gang",
          pesan: "Ketua Gang " + penyetorNama + " membuat QRIS Rp35.000 atas nama " +
            warga.nama_lengkap + " untuk iuran " + bulan + ". Menunggu konfirmasi Midtrans.",
          jenis: "iuran",
          tautan: "/admin",
          referensi_id: rowsTersimpan[0].id,
          sudah_dibaca: false
        }
      });
    } catch (notifError) {
      console.error("NOTIFIKASI SETORAN KETUA GANG ERROR:", notifError?.message || notifError);
    }

    const qrAction = Array.isArray(transaksi.actions)
      ? transaksi.actions.find(action => action.name === "generate-qr-code")
      : null;
    return res.json({
      ok: true,
      order_id: orderId,
      warga_id: warga.id,
      nama_warga: warga.nama_lengkap,
      bulan,
      total,
      status: "menunggu_pembayaran",
      jalur_pembayaran: "ketua_gang_qris",
      disetorkan_oleh: penyetorNama,
      qr_url: qrAction?.url || null,
      qr_string: transaksi.qr_string || null,
      message: "QRIS berhasil dibuat. Iuran baru menjadi lunas setelah Midtrans mengonfirmasi pembayaran."
    });
  } catch (error) {
    console.error("SETORAN QRIS KETUA GANG ERROR:", error?.message || error);
    if (orderId && rowsTersimpan.length === 0) {
      try {
        const check = await supabaseRequest("iuran_warga", {
          query: "select=id&bukti_transfer=eq." + encodeURIComponent("MIDTRANS:" + orderId) + "&limit=1"
        });
        const alreadyReserved = Array.isArray(check) && check.length > 0;
        if (!alreadyReserved) {
          const serverKey = getMidtransServerKeyForOrder(orderId);
          if (serverKey) {
            const canceled = await cancelPendingMidtransTransaction({
              orderId,
              serverKey,
              apiBase: getMidtransApiBaseForOrder(orderId)
            });
            if (!canceled.ok) console.warn("SETORAN QRIS PERLU REKONSILIASI:", canceled);
          }
        }
      } catch (reconcileError) {
        console.error("SETORAN QRIS REKONSILIASI ERROR:", reconcileError?.message || reconcileError);
      }
    }
    return res.status(getSupabaseErrorCode(error) === "23505" ? 409 : 500).json({
      ok: false,
      message: rowsTersimpan.length
        ? "QRIS sudah dibuat dan tercatat, tetapi penyimpanan atribusi petugas perlu diperiksa Bendahara. Jangan membuat transaksi baru."
        : "Gagal membuat setoran QRIS. Periksa riwayat iuran sebelum mencoba lagi."
    });
  }
});

/* RIWAYAT SETORAN QRIS KETUA GANG */
app.get("/api/ketua-gang/riwayat-setoran", requireGangLead, async (req, res) => {
  try {
    const penyetorId = Number(req.session.id);
    if (!Number.isSafeInteger(penyetorId) || penyetorId <= 0) {
      return res.status(403).json({ ok: false, message: "Identitas akun Ketua Gang tidak valid." });
    }
    const rows = await supabaseRequest("iuran_warga", {
      query: "select=id,warga_id,bulan,status,total_amount,bukti_transfer,dibayar_at,midtrans_status,midtrans_settlement_at,jalur_pembayaran,disetorkan_oleh_id,disetorkan_oleh_nama" +
        "&jalur_pembayaran=eq.ketua_gang_qris&disetorkan_oleh_id=eq." +
        encodeURIComponent(penyetorId) + "&order=bulan.desc&limit=500"
    });
    const data = Array.isArray(rows) ? rows : [];
    const ids = [...new Set(data.map(row => String(row.warga_id || "")).filter(id => /^\d+$/.test(id)))];
    const names = new Map();
    if (ids.length) {
      const wargaRows = await supabaseRequest("warga", {
        query: "select=id,nama_lengkap&id=in.(" + ids.map(encodeURIComponent).join(",") + ")"
      });
      (Array.isArray(wargaRows) ? wargaRows : []).forEach(row => names.set(String(row.id), row.nama_lengkap || ""));
    }
    return res.json(data.map(row => ({
      ...row,
      nama_warga: names.get(String(row.warga_id)) || "Warga tidak ditemukan"
    })));
  } catch (error) {
    console.error("RIWAYAT SETORAN KETUA GANG ERROR:", error?.message || error);
    return res.status(500).json({ ok: false, message: "Gagal memuat riwayat setoran QRIS." });
  }
});

/* BAYAR IURAN BEBERAPA BULAN SEKALIGUS - QRIS */
app.post("/api/iuran/bayar-banyak", requireWarga, async (req, res) => {
  let orderId = null;
  let rowsTersimpan = [];

  try {
    const bulans = req.body.bulans;

    if (
      !Array.isArray(bulans) ||
      bulans.length === 0 ||
      bulans.length > 12
    ) {
      return res.status(400).json({
        ok: false,
        message: "Pilih minimal satu bulan dan maksimal 12 bulan."
      });
    }

    const valid = bulans.every(b =>
      typeof b === "string" &&
      /^\d{4}-(0[1-9]|1[0-2])$/.test(b)
    );

    if (!valid || new Set(bulans).size !== bulans.length) {
      return res.status(400).json({
        ok: false,
        message: "Pilihan bulan tidak valid atau duplikat."
      });
    }

    const dipilih = [...bulans].sort();

    if (dipilih[0] < "2026-10") {
      return res.status(400).json({
        ok: false,
        message: "Pencatatan iuran dimulai Oktober 2026."
      });
    }

    const wargaData = await supabaseRequest("warga", {
      query:
        "select=id,nama_lengkap,keluarga_id" +
        `&id=eq.${encodeURIComponent(req.session.wargaId)}` +
        "&limit=1"
    });

    const warga = Array.isArray(wargaData) ? wargaData[0] : null;

    if (!warga || !warga.keluarga_id) {
      return res.status(400).json({
        ok: false,
        message: "Data keluarga belum terhubung. Hubungi Ketua RT."
      });
    }

    const keluargaId = String(warga.keluarga_id);

  const dataLama = await supabaseRequest("iuran_warga", {
  query:
    "select=id,warga_id,keluarga_id,bulan,status,total_amount,bukti_transfer" +
    `&keluarga_id=eq.${encodeURIComponent(keluargaId)}` +
    "&order=bulan.asc"
});

    const catatan = Array.isArray(dataLama) ? dataLama : [];
    const peta = new Map(
      catatan.map(row => [String(row.bulan).slice(0, 7), row])
    );


const iuranKedaluwarsa = [];

for (const bulan of dipilih) {
  if (peta.has(bulan)) {
    const row = peta.get(bulan);

    if (row.status === "lunas") {
      return res.status(409).json({
        ok: false,
        message: `Iuran ${bulan} sudah lunas.`
      });
    }

    const bukti = String(row.bukti_transfer || "");

    if (!bukti.startsWith("MIDTRANS:")) {
      return res.status(409).json({
        ok: false,
        message: `Iuran ${bulan} masih tercatat dan belum lunas.`
      });
    }

    // Fail closed: jangan mengganti referensi order lama hanya berdasarkan
    // hasil pemeriksaan status Midtrans. Status dapat berubah menjadi settlement
    // tepat setelah pemeriksaan dan sebelum reservasi database, sehingga webhook
    // pembayaran lama kehilangan kaitan ke catatan iuran.
    // Pemrosesan ulang transaksi kedaluwarsa dibuka kembali setelah riwayat order
    // Midtrans disimpan terpisah dan webhook dapat merekonsiliasi setiap order.
    return res.status(409).json({
      ok: false,
      message:
        `Iuran ${bulan} masih terhubung ke transaksi QRIS sebelumnya. ` +
        "Hubungi Ketua RT untuk pemeriksaan transaksi sebelum mencoba membayar kembali."
    });
  }
}

    const terakhir = dipilih[dipilih.length - 1];
    const bulanDipilih = new Set(dipilih);
    const akhir = new Date(
      Number(terakhir.slice(0, 4)),
      Number(terakhir.slice(5, 7)) - 1,
      1
    );

    for (
      let d = new Date(2026, 9, 1);
      d <= akhir;
      d.setMonth(d.getMonth() + 1)
    ) {
      const bulan =
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const record = peta.get(bulan);

      if (record?.status === "lunas") continue;


if (record && !iuranKedaluwarsa.some(
  row => String(row.id) === String(record.id)
)) {
  return res.status(409).json({
    ok: false,
    message: `Iuran ${bulan} masih tercatat dan belum lunas.`
  });
}


      if (!bulanDipilih.has(bulan)) {
        return res.status(409).json({
          ok: false,
          message: `Pilih juga iuran ${bulan} sebelum mengajukan bulan berikutnya.`
        });
      }
    }

    const total = 35000 * dipilih.length;
    orderId =
      `${getMidtransModeInfo().mode === "production" ? "RTTBK-PROD-" : "RTTBK-SBX-"}${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    // Buat transaksi QRIS terlebih dahulu.
    const transaksi = await buatTransaksiQRIS({
      orderId,
      total,
      namaWarga: warga.nama_lengkap
    });


const idsPengganti = iuranKedaluwarsa.map(row => Number(row.id));
const hasilReserva = await supabaseRequest("rpc/reserve_qris_iuran_batch", {
  method: "POST",
  body: {
    p_warga_id: String(warga.id),
    p_keluarga_id: keluargaId,
    p_bulans: dipilih.map(bulan => bulan + "-01"),
    p_replace_ids: idsPengganti,
    p_order_id: orderId
  }
});

rowsTersimpan = Array.isArray(hasilReserva) ? hasilReserva : [];
if (
  rowsTersimpan.length !== dipilih.length ||
  rowsTersimpan.some(row => row.bukti_transfer !== `MIDTRANS:${orderId}`)
) {
  throw new Error("Reservasi iuran QRIS tidak lengkap atau tidak cocok dengan order.");
}



    for (const row of rowsTersimpan) {
      try {
        await supabaseRequest("notifikasi", {
          method: "POST",
          body: {
            penerima_peran: "admin",
            judul: "Pembayaran QRIS Menunggu",
            pesan:
              `${warga.nama_lengkap || "Warga"} membuat transaksi QRIS ` +
              `untuk iuran ${String(row.bulan).slice(0, 7)}. ` +
              `Order ID: ${orderId}.`,
            jenis: "iuran",
            tautan: "/admin",
            referensi_id: row.id,
            sudah_dibaca: false
          }
        });
      } catch (err) {
        console.error("NOTIFIKASI QRIS ERROR:", err?.message || err);
      }
    }

    const qrAction = Array.isArray(transaksi.actions)
      ? transaksi.actions.find(a => a.name === "generate-qr-code")
      : null;

    return res.json({
      ok: true,
      order_id: orderId,
      total,
      bulans: dipilih,
      qr_url: qrAction?.url || null,
      qr_string: transaksi.qr_string || null,
      transaction_status: transaksi.transaction_status || "pending",
      message: "QRIS berhasil dibuat. Selesaikan pembayaran melalui QRIS."
    });
  } catch (error) {
    console.error("BAYAR IURAN QRIS ERROR:", error?.message || error);

    // If the atomic reservation did not persist any rows, reconcile the
    // external Midtrans order. Never cancel after a successful DB reservation.
    if (orderId && rowsTersimpan.length === 0) {
      try {
        // A network/response error can happen after Postgres committed.
        // Verify the order marker before cancelling the external payment.
        const rekonsiliasi = await supabaseRequest("iuran_warga", {
          query:
            "select=id" +
            "&bukti_transfer=eq." +
            encodeURIComponent(`MIDTRANS:${orderId}`) +
            "&limit=1"
        });
        const orderSudahTersimpan =
          Array.isArray(rekonsiliasi) && rekonsiliasi.length > 0;

        if (orderSudahTersimpan) {
          console.warn("MIDTRANS CANCEL SKIPPED: order already exists in database.");
        } else {
          const serverKey = getMidtransServerKeyForOrder(orderId);
          const apiBase = getMidtransApiBaseForOrder(orderId);
          if (serverKey) {
            const pembatalan = await cancelPendingMidtransTransaction({
              orderId,
              serverKey,
              apiBase
            });
            if (!pembatalan.ok) {
              console.warn("QRIS RECONCILIATION NEEDS REVIEW:", {
                orderId,
                status: pembatalan.status,
                reason: pembatalan.reason
              });
            }
          }
        }
      } catch (cancelError) {
        // Fail closed: if database reconciliation is unavailable, do not
        // cancel a payment whose reservation state cannot be confirmed.
        console.error("QRIS RECONCILIATION ERROR:", cancelError?.message || cancelError);
      }
    }
    return res.status(
      getSupabaseErrorCode(error) === "23505" ? 409 : 500
    ).json({
      ok: false,
      message:
        "Transaksi QRIS belum berhasil disiapkan. Periksa status iuran sebelum mencoba kembali."
    });
  }
});



/* RIWAYAT TRANSAKSI QRIS - KHUSUS ADMIN */
app.get("/api/qris/history", requireFinance, async (req, res) => {
  try {
    const data = await supabaseRequest("iuran_warga", {
      query:
        "select=id,bulan,status,total_amount,bukti_transfer,dibayar_at,diverifikasi_at,diverifikasi_oleh,midtrans_transaction_id,midtrans_status,midtrans_settlement_at,midtrans_notifikasi_at,jalur_pembayaran,disetorkan_oleh_nama" +
        "&bukti_transfer=like." +
        encodeURIComponent("MIDTRANS:%") +
        "&order=bulan.desc&limit=1000"
    });

    const rows = Array.isArray(data) ? data : [];
    const transaksi = new Map();

    for (const row of rows) {
      const bukti = String(row.bukti_transfer || "");
      if (!bukti.startsWith("MIDTRANS:")) continue;

      const orderId = bukti.slice("MIDTRANS:".length);
      if (!orderId) continue;

      if (!transaksi.has(orderId)) {
        transaksi.set(orderId, {
          order_id: orderId,
          jalur_pembayaran: row.jalur_pembayaran || "warga_qris",
          disetorkan_oleh_nama: row.disetorkan_oleh_nama || null,
          transaction_id: row.midtrans_transaction_id || null,
          status_midtrans: row.midtrans_status || null,
          waktu_settlement: row.midtrans_settlement_at || null,
          waktu_notifikasi: row.midtrans_notifikasi_at || null,
          total: 0,
          jumlah_bulan: 0,
          bulan: [],
          rincian: [],
          status: "lunas",
          waktu: null
        });
      }

      const item = transaksi.get(orderId);
      const nominal = Number(row.total_amount) || 0;

      // Ambil bukti yang tersedia dari setiap baris iuran.
      if (!item.transaction_id && row.midtrans_transaction_id) {
        item.transaction_id = row.midtrans_transaction_id;
      }

      if (!item.status_midtrans && row.midtrans_status) {
        item.status_midtrans = row.midtrans_status;
      }

      if (!item.waktu_settlement && row.midtrans_settlement_at) {
        item.waktu_settlement = row.midtrans_settlement_at;
      }

      if (!item.waktu_notifikasi && row.midtrans_notifikasi_at) {
        item.waktu_notifikasi = row.midtrans_notifikasi_at;
      }

      item.total += nominal;
      item.jumlah_bulan += 1;
      item.bulan.push(String(row.bulan || "").slice(0, 7));

      item.rincian.push({
        iuran_id: row.id,
        bulan: String(row.bulan || "").slice(0, 7),
        nominal,
        status: String(row.status || "belum diketahui"),
        waktu_pembayaran: row.dibayar_at || null,
        waktu_verifikasi: row.diverifikasi_at || null,
        diverifikasi_oleh: row.diverifikasi_oleh || null,
        jalur_pembayaran: row.jalur_pembayaran || "warga_qris",
        disetorkan_oleh_nama: row.disetorkan_oleh_nama || null
      });

      if (row.status !== "lunas") {
        item.status = "menunggu_pembayaran";
      }

      const waktu = row.dibayar_at || row.diverifikasi_at;
      if (waktu && (!item.waktu || waktu > item.waktu)) {
        item.waktu = waktu;
      }
    }

    const hasil = [...transaksi.values()].map(item => ({
      ...item,
      bulan: [...new Set(item.bulan)].sort(),
      rincian: item.rincian.sort((a, b) =>
        String(a.bulan).localeCompare(String(b.bulan))
      )
    }));

    hasil.sort((a, b) =>
      String(b.waktu || "").localeCompare(String(a.waktu || ""))
    );

    return res.json({
      ok: true,
      mode: getMidtransModeInfo(),
      sumber: "Database iuran RT TBK",
      catatan:
        "Data transaksi berasal dari database aplikasi. Status dan waktu Midtrans ditampilkan jika telah diterima dan disimpan dari notifikasi yang valid. Konfirmasi transaksi resmi dan pencairan dana harus diperiksa secara terpisah.",
      data: hasil
    });
  } catch (error) {
    console.error("QRIS HISTORY ERROR:", error?.message || error);

    return res.status(500).json({
      ok: false,
      message: "Gagal mengambil riwayat transaksi QRIS."
    });
  }
});

/* RIWAYAT TRANSAKSI QRIS - KHUSUS WARGA SENDIRI */
app.get("/api/qris/my-history", requireWarga, async (req, res) => {
  try {
    // Identifikasi warga dari sesi login, bukan dari input browser.
    const wargaData = await supabaseRequest("warga", {
      query:
        "select=id,keluarga_id" +
        `&id=eq.${encodeURIComponent(req.session.wargaId)}` +
        "&limit=1"
    });

    const warga = Array.isArray(wargaData) ? wargaData[0] : null;

    if (!warga || !warga.keluarga_id) {
      return res.status(400).json({
        ok: false,
        message: "Data keluarga belum terhubung. Hubungi Ketua RT."
      });
    }

    const data = await supabaseRequest("iuran_warga", {
      query:
        "select=id,keluarga_id,bulan,status,total_amount,bukti_transfer,dibayar_at,diverifikasi_at,diverifikasi_oleh,midtrans_transaction_id,midtrans_status,midtrans_settlement_at,midtrans_notifikasi_at,jalur_pembayaran,disetorkan_oleh_nama" +
        `&keluarga_id=eq.${encodeURIComponent(String(warga.keluarga_id))}` +
        "&bukti_transfer=like." +
        encodeURIComponent("MIDTRANS:%") +
        "&order=bulan.desc&limit=500"
    });

    const rows = Array.isArray(data) ? data : [];
    const transaksi = new Map();

    for (const row of rows) {
      const bukti = String(row.bukti_transfer || "");
      if (!bukti.startsWith("MIDTRANS:")) continue;

      const orderId = bukti.slice("MIDTRANS:".length);
      if (!orderId) continue;

      if (!transaksi.has(orderId)) {
        transaksi.set(orderId, {
          order_id: orderId,
          jalur_pembayaran: row.jalur_pembayaran || "warga_qris",
          disetorkan_oleh_nama: row.disetorkan_oleh_nama || null,
          transaction_id: row.midtrans_transaction_id || null,
          status_midtrans: row.midtrans_status || null,
          waktu_settlement: row.midtrans_settlement_at || null,
          waktu_notifikasi: row.midtrans_notifikasi_at || null,
          total: 0,
          jumlah_bulan: 0,
          bulan: [],
          rincian: [],
          status: "lunas",
          waktu: null
        });
      }

      const item = transaksi.get(orderId);
      const nominal = Number(row.total_amount) || 0;

      if (!item.transaction_id && row.midtrans_transaction_id) {
        item.transaction_id = row.midtrans_transaction_id;
      }
      if (!item.status_midtrans && row.midtrans_status) {
        item.status_midtrans = row.midtrans_status;
      }
      if (!item.waktu_settlement && row.midtrans_settlement_at) {
        item.waktu_settlement = row.midtrans_settlement_at;
      }
      if (!item.waktu_notifikasi && row.midtrans_notifikasi_at) {
        item.waktu_notifikasi = row.midtrans_notifikasi_at;
      }

      item.total += nominal;
      item.jumlah_bulan += 1;
      item.bulan.push(String(row.bulan || "").slice(0, 7));

      item.rincian.push({
        iuran_id: row.id,
        bulan: String(row.bulan || "").slice(0, 7),
        nominal,
        status: String(row.status || "belum diketahui"),
        waktu_pembayaran: row.dibayar_at || null,
        waktu_verifikasi: row.diverifikasi_at || null,
        diverifikasi_oleh: row.diverifikasi_oleh || null,
        jalur_pembayaran: row.jalur_pembayaran || "warga_qris",
        disetorkan_oleh_nama: row.disetorkan_oleh_nama || null
      });

      if (row.status !== "lunas") {
        item.status = "menunggu_pembayaran";
      }

      const waktu = row.dibayar_at || row.diverifikasi_at;
      if (waktu && (!item.waktu || waktu > item.waktu)) {
        item.waktu = waktu;
      }
    }

    const hasil = [...transaksi.values()].map(item => ({
      ...item,
      bulan: [...new Set(item.bulan)].sort(),
      rincian: item.rincian.sort((a, b) =>
        String(a.bulan).localeCompare(String(b.bulan))
      )
    }));

    hasil.sort((a, b) =>
      String(b.waktu || "").localeCompare(String(a.waktu || ""))
    );

    return res.json({
      ok: true,
      mode: getMidtransModeInfo(),
      sumber: "Riwayat transaksi keluarga sendiri",
      catatan:
        "Data hanya mencakup pembayaran QRIS keluarga yang sedang login. Konfirmasi transaksi resmi dan pencairan dana harus diperiksa secara terpisah.",
      data: hasil
    });
  } catch (error) {
    console.error("QRIS MY HISTORY ERROR:", error?.message || error);

    return res.status(500).json({
      ok: false,
      message: "Gagal mengambil riwayat transaksi QRIS keluarga."
    });
  }
});

/* BAYAR IURAN - WARGA: SATU KK SATU PEMBAYARAN PER BULAN */
app.post("/api/iuran/bayar", requireWarga, async (req, res) => {
  try {
    const inputBulan = req.body?.bulan;

    if (!isValidIuranMonth(inputBulan)) {
      return res.status(400).json({
        ok: false,
        message: "Bulan iuran tidak valid. Pembayaran dimulai Oktober 2026."
      });
    }

    const bulan = inputBulan + "-01";

    const wargaData = await supabaseRequest("warga", {
      query:
        "select=id,nama_lengkap,keluarga_id" +
        `&id=eq.${encodeURIComponent(req.session.wargaId)}` +
        "&limit=1"
    });

    const warga = Array.isArray(wargaData) ? wargaData[0] : null;

    if (!warga || !warga.keluarga_id) {
      return res.status(400).json({
        ok: false,
        message: "Data keluarga belum terhubung. Hubungi Ketua RT."
      });
    }

    const keluargaId = String(warga.keluarga_id);

    const existing = await supabaseRequest("iuran_warga", {
      query:
        "select=id,warga_id,keluarga_id,bulan,status,total_amount" +
        `&keluarga_id=eq.${encodeURIComponent(keluargaId)}` +
        `&bulan=eq.${encodeURIComponent(bulan)}` +
        "&limit=1"
    });

    // Jika pembayaran sudah ada, jangan membuat pembayaran kedua.
    if (Array.isArray(existing) && existing.length) {
      const pembayaran = existing[0];

      // Pengaju yang sama: pulihkan notifikasi bila diperlukan.
      if (String(pembayaran.warga_id) === String(warga.id)) {
        if (pembayaran.status === "menunggu_verifikasi") {
          try {
            const notifAda = await supabaseRequest("notifikasi", {
              query:
                "select=id" +
                "&penerima_peran=eq.admin" +
                "&jenis=eq.iuran" +
                `&referensi_id=eq.${encodeURIComponent(pembayaran.id)}` +
                "&limit=1"
            });

            if (!Array.isArray(notifAda) || notifAda.length === 0) {
              await supabaseRequest("notifikasi", {
                method: "POST",
                body: {
                  penerima_peran: "admin",
                  judul: "Pembayaran Iuran Menunggu Verifikasi",
                  pesan:
                    `${warga.nama_lengkap || "Warga"} mengajukan iuran bulan ${inputBulan}. ` +
                    "Total pembayaran Rp35.000. Menunggu verifikasi Ketua RT.",
                  jenis: "iuran",
                  tautan: "/admin",
                  referensi_id: pembayaran.id,
                  sudah_dibaca: false
                }
              });
            }
          } catch (notifError) {
            console.error(
              "PEMULIHAN NOTIFIKASI IURAN ERROR:",
              notifError?.message || notifError
            );
          }
        }

        return res.json({
          ok: true,
          data: pembayaran
        });
      }

      // Pembayaran milik anggota KK lainnya.
      let namaPembayar = "anggota keluarga lainnya";

      if (pembayaran.warga_id) {
        const pembayarData = await supabaseRequest("warga", {
          query:
            "select=id,nama_lengkap" +
            `&id=eq.${encodeURIComponent(pembayaran.warga_id)}` +
            "&limit=1"
        });

        if (Array.isArray(pembayarData) && pembayarData.length) {
          namaPembayar =
            pembayarData[0].nama_lengkap || namaPembayar;
        }
      }

      const sudahLunas = pembayaran.status === "lunas";

      return res.status(409).json({
        ok: false,
        message: sudahLunas
          ? `Iuran bulan ${inputBulan} sudah lunas dan dibayarkan oleh ${namaPembayar}. KK ini tidak perlu membayar lagi.`
          : `Iuran bulan ${inputBulan} sudah diajukan oleh ${namaPembayar} dan masih menunggu verifikasi. Anggota KK ini tidak perlu mengajukan lagi.`
      });
    }

    // Simpan pembayaran baru.
    const data = await supabaseRequest("iuran_warga", {
      method: "POST",
      body: {
        warga_id: String(warga.id),
        keluarga_id: keluargaId,
        bulan,
        status: "menunggu_verifikasi",
        total_amount: 35000
      }
    });

    const row = Array.isArray(data) ? data[0] : data;

    if (!row || row.id == null) {
      throw new Error("Data pembayaran tidak ditemukan setelah disimpan.");
    }

    // Buat notifikasi admin untuk pembayaran baru.
      try {
      await supabaseRequest("notifikasi", {
        method: "POST",
        body: {
          penerima_peran: "admin",
          judul: "Pembayaran Iuran Menunggu Verifikasi",
          pesan:
            `${warga.nama_lengkap || "Warga"} mengajukan iuran bulan ${inputBulan}. ` +
            "Total pembayaran Rp35.000. Menunggu verifikasi Ketua RT.",
          jenis: "iuran",
          tautan: "/admin",
          referensi_id: row.id,
          sudah_dibaca: false
        }
      });
    } catch (notifError) {
      console.error(
        "NOTIFIKASI PEMBAYARAN IURAN ERROR:",
        notifError?.message || notifError
      );

      return res.status(500).json({
        ok: false,
        message:
          "Pembayaran tersimpan, tetapi notifikasi admin gagal dibuat. Hubungi Ketua RT."
      });
    }
    return res.json({
      ok: true,
      data: row
    });

  } catch (error) {
    console.error("BAYAR IURAN ERROR:", error);

    // Tangani dua permintaan bersamaan tanpa membuat pembayaran ganda.
    try {
      const inputBulan = String(req.body.bulan || "").slice(0, 7);

      if (
        getSupabaseErrorCode(error) === "23505" &&
        /^\d{4}-\d{2}$/.test(inputBulan)
      ) {
        const wargaData = await supabaseRequest("warga", {
          query:
            "select=id,nama_lengkap,keluarga_id" +
            `&id=eq.${encodeURIComponent(req.session.wargaId)}` +
            "&limit=1"
        });

        const warga = Array.isArray(wargaData)
          ? wargaData[0]
          : null;

        if (warga && warga.keluarga_id) {
          const bulan = inputBulan + "-01";

          const existing = await supabaseRequest("iuran_warga", {
            query:
              "select=id,warga_id,keluarga_id,bulan,status,total_amount" +
              `&keluarga_id=eq.${encodeURIComponent(String(warga.keluarga_id))}` +
              `&bulan=eq.${encodeURIComponent(bulan)}` +
              "&limit=1"
          });

          if (Array.isArray(existing) && existing.length) {
            const pembayaran = existing[0];

            if (String(pembayaran.warga_id) === String(warga.id)) {
              // Pulihkan notifikasi tanpa menggagalkan respons pembayaran.
              if (pembayaran.status === "menunggu_verifikasi") {
                try {
                  const notifAda = await supabaseRequest("notifikasi", {
                    query:
                      "select=id" +
                      "&penerima_peran=eq.admin" +
                      "&jenis=eq.iuran" +
                      `&referensi_id=eq.${encodeURIComponent(pembayaran.id)}` +
                      "&limit=1"
                  });

                  if (!Array.isArray(notifAda) || notifAda.length === 0) {
                    await supabaseRequest("notifikasi", {
                      method: "POST",
                      body: {
                        penerima_peran: "admin",
                        judul: "Pembayaran Iuran Menunggu Verifikasi",
                        pesan:
                          `${warga.nama_lengkap || "Warga"} mengajukan iuran bulan ${inputBulan}. ` +
                          "Total pembayaran Rp35.000. Menunggu verifikasi Ketua RT.",
                        jenis: "iuran",
                        tautan: "/admin",
                        referensi_id: pembayaran.id,
                        sudah_dibaca: false
                      }
                    });
                  }
                } catch (notifError) {
                  console.error(
                    "PEMULIHAN NOTIFIKASI IURAN ERROR:",
                    notifError?.message || notifError
                  );
                }

                return res.json({
                  ok: true,
                  data: pembayaran
                });
              }

              return res.json({
                ok: true,
                data: pembayaran
              });
            }

            let namaPembayar = "anggota keluarga lainnya";

            if (pembayaran.warga_id) {
              const pembayarData = await supabaseRequest("warga", {
                query:
                  "select=id,nama_lengkap" +
                  `&id=eq.${encodeURIComponent(pembayaran.warga_id)}` +
                  "&limit=1"
              });

              if (Array.isArray(pembayarData) && pembayarData.length) {
                namaPembayar =
                  pembayarData[0].nama_lengkap || namaPembayar;
              }
            }

            const sudahLunas = pembayaran.status === "lunas";

            return res.status(409).json({
              ok: false,
              message: sudahLunas
                ? `Iuran bulan ${inputBulan} sudah lunas dan dibayarkan oleh ${namaPembayar}. KK ini tidak perlu membayar lagi.`
                : `Iuran bulan ${inputBulan} sudah diajukan oleh ${namaPembayar} dan masih menunggu verifikasi. Anggota KK ini tidak perlu mengajukan lagi.`
            });
          }
        }
      }
    } catch (recoveryError) {
      console.error("PEMULIHAN IURAN ERROR:", recoveryError);
    }

    return res.status(500).json({
      ok: false,
      message: "Gagal menyimpan pembayaran iuran. Silakan coba lagi."
    });
  }
});

/* VERIFIKASI IURAN - KETUA RT */
app.post("/api/iuran/verifikasi", requireFinance, async (req, res) => {
  try {
    const id = String(req.body?.id || "").trim();
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({
        ok: false,
        message: "ID iuran wajib berupa angka yang valid."
      });
    }

    // Pengesahan dan tiga pencatatan kas dilakukan atomik di PostgreSQL.
    // Browser tidak dapat menentukan nominal, status lunas, atau petugas.
    const diverifikasiOleh = String(
      req.session.adminUser || req.session.nama || "Petugas Keuangan"
    ).trim().slice(0, 120);

    const hasil = await supabaseRequest("rpc/verifikasi_iuran_atomic", {
      method: "POST",
      body: {
        p_iuran_id: Number(id),
        p_diverifikasi_oleh: diverifikasiOleh
      }
    });

    const row = Array.isArray(hasil) ? hasil[0] : hasil;
    if (!row || String(row.id) !== id || row.status !== "lunas") {
      return res.status(409).json({
        ok: false,
        message: "Verifikasi belum dapat dipastikan. Periksa riwayat iuran sebelum mengulangi."
      });
    }

    // Notifikasi bukan bagian dari transaksi keuangan; kegagalannya tidak
    // membatalkan pelunasan yang sudah tersimpan secara atomik.
    try {
      await supabaseRequest("notifikasi", {
        method: "POST",
        body: {
          penerima_peran: "warga",
          penerima_warga_id: Number(row.warga_id),
          judul: "Pembayaran Iuran Terverifikasi",
          pesan:
            `Pembayaran iuran bulan ${String(row.bulan || "").slice(0, 7)} ` +
            "sebesar Rp35.000 telah diverifikasi dan dinyatakan lunas.",
          jenis: "iuran",
          tautan: "/",
          referensi_id: row.id,
          sudah_dibaca: false
        }
      });
    } catch (notifError) {
      console.error("NOTIFIKASI VERIFIKASI IURAN ERROR:", notifError);
    }

    return res.json({
      ok: true,
      message: "Iuran berhasil diverifikasi dan dicatat ke kas secara atomik.",
      data: row
    });
  } catch (error) {
    console.error("VERIFIKASI IURAN ERROR:", error);
    const code = getSupabaseErrorCode(error);
    return res.status(code === "P0002" ? 404 : 500).json({
      ok: false,
      message: code === "P0002"
        ? "Data iuran tidak ditemukan."
        : "Gagal memverifikasi iuran. Status dan kas tidak diubah sebagian."
    });
  }
});

/* HEALTH CHECK */

/* ASPIRASI WARGA RT TBK */
async function namaPemilikAspirasi(wargaId) {
  const rows = await supabaseRequest("warga", {
    query: "select=id,nama_lengkap&id=eq." + encodeURIComponent(wargaId) + "&limit=1"
  });
  return Array.isArray(rows) && rows[0] ? rows[0].nama_lengkap : "Warga";
}

app.get("/api/aspirasi", requireLogin, async (req, res) => {
  try {
    const admin = req.session.role === "admin";
    const query = admin
      ? "select=*&order=created_at.desc&limit=500"
      : "select=*&warga_id=eq." + encodeURIComponent(req.session.wargaId) + "&order=created_at.desc";
    const rows = await supabaseRequest("aspirasi_warga", { query });
    if (admin && Array.isArray(rows)) {
      const ids = [...new Set(rows.map(x => String(x.warga_id)).filter(x => /^\d+$/.test(x)))];
      const map = new Map();
      if (ids.length) {
        const warga = await supabaseRequest("warga", { query: "select=id,nama_lengkap&id=in.(" + ids.join(",") + ")" });
        (Array.isArray(warga) ? warga : []).forEach(x => map.set(String(x.id), x.nama_lengkap));
      }
      return res.json(rows.map(x => ({ ...x, nama_warga: map.get(String(x.warga_id)) || "Warga" })));
    }
    return res.json(Array.isArray(rows) ? rows : []);
  } catch (error) {
    console.error("ASPIRASI LIST ERROR:", error?.message || error);
    return res.status(500).json({ ok:false, message:"Gagal memuat aspirasi. Pastikan tabel aspirasi_warga sudah dibuat di Supabase." });
  }
});

app.post("/api/aspirasi", requireWarga, async (req, res) => {
  try {
    const b = req.body || {};
    const judul = String(b.judul || "").trim();
    const kategori = String(b.kategori || "").trim();
    const lokasi = String(b.lokasi || "").trim();
    const uraian = String(b.uraian || "").trim();
    if (!judul || !kategori || !lokasi || !uraian) {
      return res.status(400).json({ ok:false, message:"Judul, kategori, lokasi, dan uraian wajib diisi." });
    }
    const dimensi = {
      kondisi_panjang: b.kondisi_panjang || null,
      kondisi_lebar: b.kondisi_lebar || null,
      kondisi_tinggi: b.kondisi_tinggi || null,
      usulan_panjang: b.usulan_panjang || null,
      usulan_lebar: b.usulan_lebar || null,
      usulan_tinggi: b.usulan_tinggi || null,
      satuan: b.satuan || "meter"
    };
    const data = await supabaseRequest("aspirasi_warga", {
      method:"POST",
      body:{
        warga_id:req.session.wargaId,
        judul:judul.slice(0,200),
        kategori:kategori.slice(0,80),
        urgensi:["Urgent","Prioritas","Reguler"].includes(b.urgensi) ? b.urgensi : "Reguler",
        lokasi:lokasi.slice(0,500),
        uraian:uraian.slice(0,5000),
        solusi_usulan:String(b.solusi_usulan || "").slice(0,5000),
        dimensi,
        rab:[],
        status:"Diajukan"
      }
    });
    const row = Array.isArray(data) ? data[0] : data;
    try {
      await supabaseRequest("notifikasi", { method:"POST", body:{
        penerima_peran:"admin", judul:"Aspirasi Warga Baru",
        pesan:`${req.session.nama || "Warga"} mengajukan aspirasi: ${judul}`,
        jenis:"aspirasi", tautan:"/admin", referensi_id:row?.id ? Number(row.id) : null, sudah_dibaca:false
      }});
    } catch(e) { console.error("NOTIF ASPIRASI ERROR:", e?.message || e); }
    return res.json({ok:true, data:row});
  } catch(error) {
    console.error("ASPIRASI CREATE ERROR:", error?.message || error);
    return res.status(500).json({ok:false, message:"Gagal menyimpan aspirasi. Periksa tabel aspirasi_warga di Supabase."});
  }
});

// Upload foto kondisi awal dan pengukuran aspirasi.
app.post("/api/aspirasi/:id/dokumentasi", requireLogin, uploadFoto.fields([
  { name: "foto_kondisi", maxCount: 1 },
  { name: "foto_pengukuran", maxCount: 1 }
]), async (req, res) => {
  try {
    const rows = await supabaseRequest("aspirasi_warga", {
      query: "select=id,warga_id,realisasi&id=eq." +
        encodeURIComponent(req.params.id) + "&limit=1"
    });

    const a = Array.isArray(rows) ? rows[0] : null;
    if (!a) {
      return res.status(404).json({
        ok: false,
        message: "Aspirasi tidak ditemukan."
      });
    }

    if (!canAccessOwnedRecord(req.session, a.warga_id)) {
      return res.status(403).json({
        ok: false,
        message: "Tidak berhak mengubah dokumentasi aspirasi ini."
      });
    }

    const files = req.files || {};
    if (!files.foto_kondisi?.[0] && !files.foto_pengukuran?.[0]) {
      return res.status(400).json({
        ok: false,
        message: "Pilih minimal satu foto."
      });
    }

    const realisasi =
      a.realisasi && typeof a.realisasi === "object"
        ? a.realisasi
        : {};

    const dokumentasi = { ...(realisasi.dokumentasi || {}) };

    for (const field of ["foto_kondisi", "foto_pengukuran"]) {
      const file = files[field]?.[0];
      if (!file) continue;

      const jenisFoto = detectImageType(file.buffer);
      if (
        !jenisFoto ||
        file.mimetype !== jenisFoto.mime ||
        !["image/jpeg", "image/png"].includes(jenisFoto.mime)
      ) {
        return res.status(400).json({
          ok: false,
          message: "Gunakan foto JPG atau PNG yang valid."
        });
      }

      const ext = jenisFoto.ext;
      const objectPath =
        `aspirasi/${a.id}/${field}-${Date.now()}.${ext}`;

      const url =
        `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent("foto warga")}/` +
        objectPath.split("/").map(encodeURIComponent).join("/");

      const up = await fetch(url, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": jenisFoto.mime,
          "x-upsert": "false"
        },
        body: file.buffer
      });

      if (!up.ok) {
        throw new Error("Gagal menyimpan foto ke Supabase Storage.");
      }

      dokumentasi[field] = {
        path: objectPath,
        nama: file.originalname,
        tipe: file.mimetype,
        diunggah_pada: new Date().toISOString()
      };
    }

    const updated = await supabaseRequest("aspirasi_warga", {
      method: "PATCH",
      query: "id=eq." + encodeURIComponent(a.id),
      body: {
        realisasi: { ...realisasi, dokumentasi },
        updated_at: new Date().toISOString()
      }
    });

    return res.json({
      ok: true,
      data: Array.isArray(updated) ? updated[0] : updated
    });
  } catch (error) {
    console.error("ASPIRASI DOKUMENTASI ERROR:", error?.message || error);
    return res.status(500).json({
      ok: false,
      message: "Gagal mengunggah dokumentasi. Silakan coba kembali."
    });
  }
});

app.patch("/api/aspirasi/:id", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const allowed = ["Verifikasi RT","Perlu revisi","Disetujui RT","Diteruskan ke kelurahan","Dalam pengerjaan","Selesai","Ditunda","Ditolak"];
    const body = {};
    if (allowed.includes(b.status)) body.status = b.status;
    if (b.catatan !== undefined) body.catatan = String(b.catatan).slice(0,3000);
    if (b.rab !== undefined) {
      try {
        body.rab = normalisasiRabAspirasi(b.rab);
      } catch (validationError) {
        return res.status(400).json({
          ok: false,
          message: validationError.message
        });
      }
    }
    if (b.rencana_kerja !== undefined) body.rencana_kerja = String(b.rencana_kerja).slice(0,5000);
    if (b.realisasi !== undefined) body.realisasi = b.realisasi;
    if (!Object.keys(body).length) return res.status(400).json({ok:false,message:"Tidak ada perubahan."});

    const existingRows = await supabaseRequest("aspirasi_warga", {
      query: "select=id,warga_id,judul,status,catatan&id=eq." +
        encodeURIComponent(req.params.id) + "&limit=1"
    });
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;
    if (!existing) {
      return res.status(404).json({ok:false,message:"Aspirasi tidak ditemukan."});
    }

    body.updated_at = new Date().toISOString();
    const data = await supabaseRequest("aspirasi_warga", {
      method:"PATCH",
      query:"id=eq." + encodeURIComponent(req.params.id),
      body
    });
    const updated = Array.isArray(data) ? data[0] : data;

    const statusBerubah = body.status !== undefined && body.status !== existing.status;
    const catatanBerubah = body.catatan !== undefined && body.catatan !== (existing.catatan || "");
    if (statusBerubah || catatanBerubah) {
      const rincian = [];
      if (statusBerubah) rincian.push("Status: " + body.status + ".");
      if (catatanBerubah && body.catatan) rincian.push("Catatan Ketua RT: " + body.catatan);
      try {
        await supabaseRequest("notifikasi", {
          method:"POST",
          body:{
            penerima_peran:"warga",
            penerima_warga_id:existing.warga_id,
            judul:"Pembaruan Aspirasi Warga",
            pesan:"Aspirasi " + String(existing.judul || "Aspirasi Anda") + " telah diperbarui. " + rincian.join(" "),
            jenis:"aspirasi",
            tautan:"/",
            referensi_id:Number(existing.id),
            sudah_dibaca:false
          }
        });
      } catch (notifError) {
        console.error("NOTIFIKASI PEMBARUAN ASPIRASI ERROR:", notifError?.message || notifError);
      }
    }

    return res.json({ok:true,data:updated});
  } catch(error) {
    console.error("ASPIRASI UPDATE ERROR:", error?.message || error);
    return res.status(500).json({ok:false,message:"Gagal memperbarui aspirasi."});
  }
});



app.get("/api/aspirasi/:id/pdf", requireAdmin, async (req, res) => {
  try {
    const fs = require("fs");

    const rows = await supabaseRequest("aspirasi_warga", {
      query: "select=*&id=eq." + encodeURIComponent(req.params.id) + "&limit=1"
    });

    const a = Array.isArray(rows) ? rows[0] : null;
    if (!a) {
      return res.status(404).json({
        ok: false,
        message: "Aspirasi tidak ditemukan."
      });
    }

    const warga = await namaPemilikAspirasi(a.warga_id);
    const d = a.dimensi || {};
    const rab = Array.isArray(a.rab) && a.rab.length ? a.rab : buatTemplateRab(a.kategori, d);
    const dokumentasi = a.realisasi?.dokumentasi || {};

    const fotoKondisiURL = await buatUrlFotoPrivat(
      dokumentasi.foto_kondisi?.path || dokumentasi.foto_kondisi
    );
    const fotoPengukuranURL = await buatUrlFotoPrivat(
      dokumentasi.foto_pengukuran?.path || dokumentasi.foto_pengukuran
    );

    // Kop proposal: lambang Kabupaten Bekasi di kiri dan logo perumahan di kanan.
    const logoKopPath = path.join(__dirname, "images.png");
    const pakaiLogoPerumahan = fs.existsSync(logoKopPath);
    const URL_LAMBANG_KABUPATEN =
      "https://upload.wikimedia.org/wikipedia/commons/1/12/Logo_Kabupaten_Bekasi.jpg";

    // Gunakan sumber lambang yang sama dengan kop Menu Surat.
    let lambangKabupatenBekasi = null;
    try {
      // Batasi waktu sumber gambar eksternal. PDF tetap dibuat dengan kop tanpa lambang
      // bila Wikimedia lambat/tidak tersedia; unduhan warga tidak boleh menggantung.
      const responsLambang = await fetch(URL_LAMBANG_KABUPATEN, {
        signal: AbortSignal.timeout(3000)
      });
      if (responsLambang.ok) {
        const tipeGambar = responsLambang.headers.get("content-type") || "";
        if (tipeGambar.startsWith("image/")) {
          const bytesLambang = Buffer.from(await responsLambang.arrayBuffer());
          if (bytesLambang.length > 0 && bytesLambang.length < 3 * 1024 * 1024) {
            lambangKabupatenBekasi = bytesLambang;
          }
        }
      }
    } catch (errorLambang) {
      console.warn("LAMBANG KABUPATEN BEKASI TIDAK DAPAT DIMUAT UNTUK ASPIRASI:", errorLambang.message);
    }

    const doc = new PDFDocument({
      size: "A4",
      margin: 48,
      bufferPages: true
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Proposal-Aspirasi-${a.id}.pdf"`
    );
    doc.pipe(res);

    const KIRI = 48;
    const KANAN = 48;
    const LEBAR = doc.page.width - KIRI - KANAN;
    const BATAS = doc.page.height - 55;
    const ATAS = 144;
    const satuan = d.satuan || "meter";

    function pasangKop() {
      // Samakan ukuran kedua lambang agar kop lebih seimbang dan mudah dibaca.
      const ukuranLogoSisi = 92;
      const xLogoKiri = KIRI;
      const xLogoKanan = doc.page.width - KANAN - ukuranLogoSisi;
      const xTeks = xLogoKiri + ukuranLogoSisi + 10;
      const lebarTeks = xLogoKanan - 10 - xTeks;

      if (lambangKabupatenBekasi) {
        doc.image(lambangKabupatenBekasi, xLogoKiri, 14, {
          fit: [ukuranLogoSisi, ukuranLogoSisi],
          align: "center",
          valign: "center"
        });
      }
      if (pakaiLogoPerumahan) {
        // Gunakan logo perumahan yang sudah ada, dengan bingkai putih tipis.
        doc.save();
        doc.lineWidth(0.9).roundedRect(
          xLogoKanan, 14, ukuranLogoSisi, ukuranLogoSisi, 7
        ).fillAndStroke("#FFFFFF", "#222222");
        // Gambar satu kali agar logo tetap tajam dan tidak tampak menebal.
        doc.image(logoKopPath, xLogoKanan + 6, 20, {
          fit: [ukuranLogoSisi - 12, ukuranLogoSisi - 12],
          align: "center",
          valign: "center"
        });
        doc.restore();
      }

      doc.save();
      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(17)
        .text("SEKRETARIAT", xTeks, 17, { width: lebarTeks, align: "center" });
      doc.font("Helvetica-Bold").fontSize(12)
        .text("PENGURUS RT 004 / RW 01", xTeks, 42, { width: lebarTeks, align: "center" });
      doc.font("Helvetica-Bold").fontSize(10)
        .text("Perumahan Taman Bali Kahuripan", xTeks, 64, { width: lebarTeks, align: "center" });
      doc.font("Helvetica-Bold").fontSize(9)
        .text("Desa Sukahurip · Kecamatan Sukatani · Kabupaten Bekasi", xTeks, 85, { width: lebarTeks, align: "center" });
      doc.moveTo(KIRI, 130).lineTo(doc.page.width - KANAN, 130).lineWidth(2.2).strokeColor("#111111").stroke();
      doc.restore();
    }

    function halamanBaru() {
      doc.addPage();
      doc.x = KIRI;
      doc.y = ATAS;
    }

    doc.on("pageAdded", () => {
      pasangKop();
      doc.x = KIRI;
      doc.y = ATAS;
    });

    pasangKop();
    doc.x = KIRI;
    doc.y = ATAS;

    function rupiah(nilai) {
      return "Rp " + Number(nilai || 0).toLocaleString("id-ID");
    }

    function nilaiUkuran(nilai) {
      if (
        nilai === null ||
        nilai === undefined ||
        String(nilai).trim() === ""
      ) {
        return "Belum diukur";
      }
      return String(nilai) + " " + satuan;
    }

    function judul(teks) {
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold")
        .fontSize(11)
        .fillColor("#17365D")
        .text(teks, KIRI, doc.y, {
          width: LEBAR
        });
      doc.moveDown(0.3);
      doc.fillColor("#000000");
    }

    function teks(label, isi) {
      doc.font("Helvetica-Bold").fontSize(9)
        .text(label, {
          continued: true,
          width: LEBAR
        });
      doc.font("Helvetica").fontSize(9)
        .text(" " + (isi || "-"), {
          width: LEBAR,
          lineGap: 2
        });
    }

    function teksParagraf(isi) {
      doc.font("Helvetica").fontSize(9)
        .text(isi || "-", {
          width: LEBAR,
          align: "justify",
          lineGap: 3
        });
    }

    function garisTabel(y, tinggi, x, lebar) {
      doc.rect(x, y, lebar, tinggi)
        .lineWidth(0.9)
        .strokeColor("#666666")
        .stroke();
    }

    // ==================================================
    // HALAMAN 1 - IDENTITAS, PERMOHONAN, DAN UKURAN
    // ==================================================

    doc.font("Helvetica-Bold").fontSize(15)
      .text("PROPOSAL ASPIRASI WARGA", {
        width: LEBAR,
        align: "center"
      });

    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9)
      .text(
        "Dokumen usulan untuk bahan peninjauan dan pertimbangan pemerintah desa/kelurahan.",
        { width: LEBAR, align: "center" }
      );

    judul("A. IDENTITAS DAN PERMOHONAN");
    teks("Nomor usulan:", "ASP-" + a.id);
    teks("Judul:", a.judul);
    teks("Nama pengusul:", warga);
    teks("Kategori:", a.kategori);
    teks("Tingkat urgensi:", a.urgensi);
    teks("Lokasi:", a.lokasi);
    teks(
      "Tanggal pengajuan:",
      a.created_at
        ? new Date(a.created_at).toLocaleDateString("id-ID")
        : "-"
    );
    teks("Status:", a.status);

    judul("B. LATAR BELAKANG DAN KONDISI LAPANGAN");
    teksParagraf(a.uraian);

    judul("C. PERBANDINGAN UKURAN KONDISI DAN USULAN");

    const ukuran = [
      ["Panjang", d.kondisi_panjang, d.usulan_panjang],
      ["Lebar", d.kondisi_lebar, d.usulan_lebar],
      ["Tinggi / kedalaman", d.kondisi_tinggi, d.usulan_tinggi]
    ];

    const kolomUkuran = [145, 177, 177];
    const tinggiHeader = 32;
    const tinggiBaris = 34;

    function headerUkuran() {
      const y = doc.y;
      let x = KIRI;

      ["PARAMETER", "KONDISI SAAT INI", "UKURAN USULAN"]
        .forEach((label, i) => {
          doc.rect(x, y, kolomUkuran[i], tinggiHeader)
            .fill("#FFFFFF");
          doc.fillColor("#000000")
            .font("Helvetica-Bold")
            .fontSize(8)
            .text(label, x + 5, y + 11, {
              width: kolomUkuran[i] - 10,
              align: "center"
            });
          x += kolomUkuran[i];
        });

      doc.y = y + tinggiHeader;
    }

    headerUkuran();

    ukuran.forEach((item) => {
      const y = doc.y;
      let x = KIRI;
      const isi = [
        item[0],
        nilaiUkuran(item[1]),
        nilaiUkuran(item[2])
      ];

      isi.forEach((v, i) => {
        garisTabel(y, tinggiBaris, x, kolomUkuran[i]);
        doc.font("Helvetica").fontSize(8)
          .fillColor("#000000")
          .text(v, x + 5, y + 10, {
            width: kolomUkuran[i] - 10,
            align: i === 0 ? "left" : "center"
          });
        x += kolomUkuran[i];
      });

      doc.y = y + tinggiBaris;
    });

    // Kembalikan titik awal paragraf ke batas kiri tabel agar tidak
    // mewarisi posisi x dari sel tabel terakhir.
    doc.x = KIRI;
    doc.moveDown(0.5);
    const yCatatanUkuran = doc.y;
    doc.font("Helvetica-Oblique").fontSize(8)
      .text(
        "Catatan: Ukuran kondisi lama dan usulan harus diverifikasi melalui pengukuran lapangan. Data yang belum diisi tidak dianggap sebagai hasil pengukuran.",
        KIRI,
        yCatatanUkuran,
        { width: LEBAR, lineGap: 2, align: "left" }
      );
    doc.x = KIRI;

    // ==================================================
    // HALAMAN 2 - SKETSA DAN DOKUMENTASI
    // ==================================================

    halamanBaru();

    doc.font("Helvetica-Bold").fontSize(13)
      .text("SKETSA DAN DOKUMENTASI LAPANGAN", {
        width: LEBAR,
        align: "center"
      });

    const kategoriProposal = infoKategoriAspirasi(a.kategori);
    judul(kategoriProposal.key === "drainase" ? "D. SKETSA PENAMPANG SALURAN" : "D. ILUSTRASI UKURAN PEKERJAAN");

    doc.font("Helvetica-Oblique").fontSize(8)
      .text(
        "Sketsa bersifat ilustrasi dan bukan gambar teknis hasil survei.",
        { width: LEBAR }
      );

    doc.moveDown(1);

    function gambarPenampang(x, y, label, lebar, tinggi) {
      const tersedia =
        lebar !== null &&
        lebar !== undefined &&
        String(lebar).trim() !== "" &&
        tinggi !== null &&
        tinggi !== undefined &&
        String(tinggi).trim() !== "";

      doc.font("Helvetica-Bold").fontSize(9)
        .text(label, x, y, {
          width: 210,
          align: "center"
        });

      if (!tersedia) {
        doc.rect(x + 25, y + 25, 160, 75)
          .lineWidth(1.5)
          .strokeColor("#444444")
          .stroke();
        doc.font("Helvetica-Oblique").fontSize(8)
          .text("Sketsa belum dapat dibuat\nUkuran belum lengkap", x + 30, y + 52, {
            width: 150,
            align: "center"
          });
        return;
      }

      const w = Math.max(
        35,
        Math.min(Number(lebar) * 45, 150)
      );
      const h = Math.max(
        25,
        Math.min(Number(tinggi) * 45, 85)
      );

      doc.rect(x + 25, y + 25, w, h)
        .lineWidth(1.8)
        .strokeColor("#000000")
        .stroke();

      doc.font("Helvetica").fontSize(8)
        .text("Lebar: " + nilaiUkuran(lebar), x, y + 115, {
          width: 210,
          align: "center"
        });
      doc.text((kategoriProposal.key === "drainase" ? "Kedalaman: " : "Tinggi / ketebalan: ") + nilaiUkuran(tinggi), x, y + 130, {
        width: 210,
        align: "center"
      });
    }

    gambarPenampang(
      55,
      doc.y,
      "KONDISI SAAT INI",
      d.kondisi_lebar,
      d.kondisi_tinggi
    );

    gambarPenampang(
      320,
      doc.y,
      "UKURAN USULAN",
      d.usulan_lebar,
      d.usulan_tinggi
    );

    doc.y += 185;

    teks("Panjang kondisi saat ini:", nilaiUkuran(d.kondisi_panjang));
    teks("Panjang usulan:", nilaiUkuran(d.usulan_panjang));

    judul("E. SOLUSI YANG DIUSULKAN");
    teksParagraf(a.solusi_usulan);

    judul("F. DOKUMENTASI KONDISI LAPANGAN");

    async function pasangFoto(url, label) {
      // Foto yang tidak tersedia hanya memakai ruang kecil; jangan membuat
      // halaman baru kosong hanya untuk mencetak keterangan foto kosong.
      if (!url) {
        if (doc.y + 55 > BATAS) halamanBaru();
        doc.font("Helvetica-Bold").fontSize(9)
          .text(label, KIRI, doc.y, { width: LEBAR });
        doc.moveDown(0.3);
        doc.font("Helvetica-Oblique").fontSize(8)
          .text("Foto dokumentasi belum tersedia.", { width: LEBAR });
        doc.moveDown(0.8);
        return;
      }

      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Foto gagal diambil");
        const buffer = Buffer.from(await response.arrayBuffer());

        // Ukur ruang sebelum menulis judul agar judul dan foto tidak terpisah.
        if (doc.y + 205 > BATAS) halamanBaru();
        doc.font("Helvetica-Bold").fontSize(9)
          .text(label, KIRI, doc.y, { width: LEBAR });
        doc.moveDown(0.3);
        const y = doc.y;
        doc.image(buffer, KIRI + 45, y, {
          fit: [LEBAR - 90, 145],
          align: "center"
        });
        doc.y = y + 160;
      } catch (error) {
        if (doc.y + 55 > BATAS) halamanBaru();
        doc.font("Helvetica-Bold").fontSize(9)
          .text(label, KIRI, doc.y, { width: LEBAR });
        doc.moveDown(0.3);
        doc.font("Helvetica-Oblique").fontSize(8)
          .text(
            "Foto tersimpan tetapi tidak dapat dimuat. Periksa kembali dokumentasi di aplikasi.",
            { width: LEBAR }
          );
        doc.moveDown(0.5);
      }
    }

    await pasangFoto(
      fotoKondisiURL,
      "1. Foto kondisi sebelum perbaikan"
    );

    await pasangFoto(
      fotoPengukuranURL,
      "2. Foto pengukuran lapangan"
    );

    // ==================================================
    // RENCANA ANGGARAN BIAYA - ALUR HALAMAN DINAMIS
    // ==================================================

    // RAB memakai halaman yang sedang berjalan bila masih cukup ruang.
    // Sediakan ruang tambahan untuk penanda DRAF agar tidak terpotong di bawah.
    if (doc.y + 185 > BATAS) halamanBaru();

    // Penanda status dibuat jelas, tetapi tidak mengubah isi atau nilai RAB.
    const yPenandaDraf = doc.y;
    doc.save();
    doc.roundedRect(KIRI, yPenandaDraf, LEBAR, 22, 4)
      .fillAndStroke("#FFF4D6", "#C58A22");
    doc.fillColor("#754B00").font("Helvetica-Bold").fontSize(8)
      .text("DRAF  •  ESTIMASI AWAL  •  BELUM MENJADI PENETAPAN ANGGARAN", KIRI + 6, yPenandaDraf + 7, {
        width: LEBAR - 12,
        align: "center",
        lineBreak: false
      });
    doc.restore();
    doc.y = yPenandaDraf + 29;

    doc.font("Helvetica-Bold").fontSize(13)
      .text("RENCANA ANGGARAN BIAYA", {
        width: LEBAR,
        align: "center"
      });

    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(8)
      .text(
        "Rincian biaya disusun berdasarkan kebutuhan pekerjaan. Volume dan harga satuan yang belum diverifikasi ditandai sebagai data draf dan wajib dilengkapi melalui survei serta pengecekan harga setempat.",
        { width: LEBAR, align: "justify" }
      );

    judul("G. RINCIAN RENCANA ANGGARAN BIAYA");

    if (!rab.length) {
      doc.font("Helvetica-Oblique").fontSize(9)
        .text(
          "DRAF RAB: rincian pekerjaan, volume, dan harga satuan belum tersedia. Lengkapi setelah survei lapangan.",
          { width: LEBAR, lineGap: 3 }
        );
    } else {
      // Susunan kolom mengikuti format RAB formal: uraian, volume,
      // harga satuan, dan jumlah; spesifikasi disatukan dengan uraian.
      const kolom = [25, 205, 65, 100, 104];
      const judulKolom = [
        "No",
        "Uraian pekerjaan / spesifikasi",
        "Volume",
        "Harga satuan",
        "Jumlah"
      ];

      function headerRAB() {
        const y = doc.y;
        let x = KIRI;
        judulKolom.forEach((label, i) => {
          doc.rect(x, y, kolom[i], 32)
            .fillAndStroke("#EAF0F6", "#666666");
          doc.fillColor("#000000")
            .font("Helvetica-Bold")
            .fontSize(7)
            .text(label, x + 3, y + 8, {
              width: kolom[i] - 6,
              align: "center"
            });
          x += kolom[i];
        });
        doc.y = y + 32;
      }

      headerRAB();
      let total = 0;
      let hargaBelumLengkap = false;

      for (let i = 0; i < rab.length; i++) {
        const item = rab[i] || {};
        const volumeDiisi = item.volume !== null && item.volume !== undefined && item.volume !== "";
        const hargaDiisi = item.harga_satuan !== null && item.harga_satuan !== undefined && item.harga_satuan !== "";
        const volume = volumeDiisi ? Number(item.volume) : 0;
        const harga = hargaDiisi ? Number(item.harga_satuan) : 0;
        const subtotalDiisi = volumeDiisi && hargaDiisi &&
          Number.isFinite(volume) && Number.isFinite(harga);
        const subtotal = subtotalDiisi ? volume * harga : null;
        if (!subtotalDiisi) hargaBelumLengkap = true;
        if (subtotalDiisi) total += subtotal;

        const uraian = [item.item, item.spesifikasi].filter(Boolean).join("\n");
        const isi = [
          String(i + 1),
          uraian || "Uraian belum diisi",
          (volumeDiisi ? String(item.volume) : "Belum diukur") +
            (item.satuan ? " " + item.satuan : ""),
          hargaDiisi ? rupiah(harga) : "Belum diisi",
          subtotalDiisi ? rupiah(subtotal) : "Belum dihitung"
        ];

        const tinggi = Math.max(38, ...isi.map((v, j) => {
          doc.font("Helvetica").fontSize(7);
          return doc.heightOfString(String(v), {
            width: kolom[j] - 10,
            lineGap: 1
          }) + 12;
        }));

        if (doc.y + tinggi + 8 > BATAS) {
          halamanBaru();
          headerRAB();
        }

        const y = doc.y;
        let x = KIRI;
        isi.forEach((v, j) => {
          doc.rect(x, y, kolom[j], tinggi)
            .lineWidth(0.7)
            .strokeColor("#777777")
            .stroke();
          doc.font("Helvetica").fontSize(7)
            .fillColor("#000000")
            .text(String(v), x + 5, y + 6, {
              width: kolom[j] - 10,
              height: tinggi - 10,
              lineGap: 1,
              align: j === 0 || j === 2 ? "center" : "left"
            });
          x += kolom[j];
        });
        doc.y = y + tinggi;
      }

      if (doc.y + 42 > BATAS) halamanBaru();
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(9)
        .text(
          hargaBelumLengkap
            ? "TOTAL RAB: BELUM DAPAT DITETAPKAN — LENGKAPI HARGA SATUAN"
            : "TOTAL RAB PERKIRAAN: " + rupiah(total),
          KIRI,
          doc.y,
          { width: LEBAR, align: "right" }
        );
    }

    doc.moveDown(0.8);
    doc.font("Helvetica-Oblique").fontSize(8)
      .text(
        "Catatan: RAB ini merupakan estimasi/draf, bukan penetapan anggaran. Volume, spesifikasi teknis, dan harga satuan harus diverifikasi melalui survei serta disesuaikan dengan harga setempat.",
        { width: LEBAR, align: "justify", lineGap: 2 }
      );

    // ==================================================
    // PELAKSANAAN DAN PENGESAHAN
    // ==================================================
    // Tidak memaksa halaman baru. Bagian ini diteruskan pada ruang
    // tersisa setelah RAB; halaman tambahan hanya dibuat bila memang
    // tidak cukup ruang untuk judul dan isi pokoknya.

    doc.x = KIRI;
    if (doc.y + 220 > BATAS) halamanBaru();

    doc.font("Helvetica-Bold").fontSize(13)
      .text("RENCANA PELAKSANAAN DAN PENGESAHAN", {
        width: LEBAR,
        align: "center"
      });

    judul("H. RENCANA PELAKSANAAN DAN TINDAKAN");

    const rencanaKerja = (a.rencana_kerja || buatRencanaKerja(a.kategori)).replace(/\*\*/g, "");

    doc.font("Helvetica").fontSize(9)
      .text(rencanaKerja, {
        width: LEBAR,
        lineGap: 4
      });

    judul("I. CATATAN DAN VERIFIKASI");

    teksParagraf(
      "Dokumen ini merupakan usulan warga. Ukuran, volume pekerjaan, harga satuan, kondisi lokasi, dan kebutuhan teknis wajib diperiksa melalui survei lapangan. Dokumen ini bukan bukti persetujuan anggaran atau perintah pelaksanaan pekerjaan."
    );

    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(10)
      .text("J. HALAMAN PENGESAHAN", {
        width: LEBAR,
        align: "center"
      });

    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(8)
      .text(
        "Proposal ini disampaikan untuk diperiksa, dipertimbangkan, dan ditindaklanjuti sesuai kewenangan serta ketentuan yang berlaku.",
        { width: LEBAR, align: "center" }
      );

    doc.moveDown(1.5);

   const lebarTTD = 155;
const jarak = (LEBAR - (lebarTTD * 3)) / 2;

const posisi = [
  KIRI,
  KIRI + lebarTTD + jarak,
  KIRI + (lebarTTD + jarak) * 2
];

const jabatan = [
  "Pengusul",
  "Ketua RT 004 / RW 01",
  "Kepala Desa / Lurah"
];

const yTanggal = doc.y;
const yJabatan = yTanggal + 16;
const yTandaTangan = yTanggal + 105;

for (let i = 0; i < 3; i++) {
  doc.font("Helvetica").fontSize(8)
    .text("Bekasi, ______________", posisi[i], yTanggal, {
      width: lebarTTD,
      align: "center"
    });

  doc.font("Helvetica-Bold").fontSize(8)
    .text(jabatan[i], posisi[i], yJabatan, {
      width: lebarTTD,
      align: "center"
    });

  doc.font("Helvetica").fontSize(8)
    .text("(_____________________)", posisi[i], yTandaTangan, {
      width: lebarTTD,
      align: "center"
    });
}

doc.y = yTandaTangan + 25;

doc.font("Helvetica-Oblique").fontSize(8)
  .text(
    "Kolom tanda tangan dan persetujuan diisi oleh pihak terkait setelah pemeriksaan dan proses persetujuan.",
    { width: LEBAR, align: "center" }
  );
  

doc.end();

  } catch (error) {
    console.error("ASPIRASI PDF ERROR:", error?.message || error);

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        message: "Gagal membuat PDF aspirasi."
      });
    } else {
      res.end();
    }
  }
});

/* UNDUH APK RESMI RT TBK — tautan publik pendek untuk warga.
   File diambil dari rilis GitHub terbaru lalu dikirim sebagai attachment,
   sehingga warga tidak perlu membuka halaman rilis atau mencari tombol aset. */
app.get("/download", async (req, res) => {
  const releaseUrl = "https://github.com/setiawanw613-blip/RT-kita-TBK/releases/latest/download/RT-TBK.apk";

  try {
    const upstream = await fetch(releaseUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "Accept": "application/octet-stream",
        "User-Agent": "RT-TBK-APK-Downloader"
      },
      signal: AbortSignal.timeout(25000)
    });

    if (!upstream.ok || !upstream.body) {
      throw new Error(`Unduhan APK dari rilis resmi gagal (HTTP ${upstream.status}).`);
    }

    const finalUrl = new URL(upstream.url);
    if (
      finalUrl.protocol !== "https:" ||
      !(finalUrl.hostname === "release-assets.githubusercontent.com" ||
        finalUrl.hostname === "objects.githubusercontent.com" ||
        finalUrl.hostname.endsWith(".githubusercontent.com"))
    ) {
      await upstream.body.cancel();
      throw new Error("Tujuan unduhan APK tidak sesuai host resmi GitHub.");
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    if (/text\/html|application\/json/i.test(contentType)) {
      await upstream.body.cancel();
      throw new Error("Server rilis tidak mengembalikan berkas APK.");
    }

    res.status(200);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", 'attachment; filename="RT-TBK.apk"');
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    const { Readable } = require("node:stream");
    Readable.fromWeb(upstream.body)
      .on("error", error => {
        console.error("STREAM UNDUHAN APK RT TBK ERROR:", error?.message || error);
        if (!res.headersSent) res.status(502).end("Unduhan APK gagal. Silakan coba kembali.");
        else res.destroy(error);
      })
      .pipe(res);
  } catch (error) {
    console.error("UNDUHAN APK RT TBK ERROR:", error?.message || error);
    if (!res.headersSent) {
      res.status(503).type("text/plain").send("APK RT TBK sementara tidak dapat diunduh. Silakan coba beberapa saat lagi.");
    }
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "RT Kita berjalan"
  });
});

/* FILE FRONTEND */
// index.html dikirim dengan tambahan script form surat (surat-form.js).
function kirimHalamanUtama(req, res) {
  const fs = require("fs");
  try {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const tambahan = '<script src="/aspirasi-rab.js?v=1"></script><script src="/surat-form.js?v=2"></script>';
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(
      html.includes("</body>")
        ? html.replace("</body>", tambahan + "\n</body>")
        : html + tambahan
    );
  } catch (error) {
    console.error("KIRIM INDEX ERROR:", error);
    res.sendFile(path.join(__dirname, "index.html"));
  }
}

app.get("/index.html", kirimHalamanUtama);

// Sajikan hanya aset yang memang dipakai antarmuka publik.
// Jangan membuka seluruh direktori proyek melalui express.static.
const PUBLIC_STATIC_FILES = new Set([
  "images.png",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "sw.js",
  "surat-form.js",
  "aspirasi-rab.js",
  "tampilan-hp.js"
]);

app.get("/:asset", (req, res, next) => {
  const asset = req.params.asset;

  if (PUBLIC_STATIC_FILES.has(asset)) {
    return res.sendFile(path.join(__dirname, asset), error => {
      if (error && !res.headersSent) next(error);
    });
  }

  // Berkas kode, konfigurasi, dokumentasi, dan migrasi tidak boleh
  // dilayani sebagai berkas statis.
  if (asset.startsWith(".") || /\.(?:js|json|md|sql|ya?ml|toml|lock|env|txt)$/i.test(asset)) {
    return res.sendStatus(404);
  }

  return next();
});

app.get("*", kirimHalamanUtama);

module.exports = app;
