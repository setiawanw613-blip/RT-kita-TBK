const express = require("express");
const path = require("path");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const multer = require("multer");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const uploadFoto = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024
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

function verifyPassword(password, storedPassword) {
  if (!storedPassword || !storedPassword.includes(":")) {
    return false;
  }

  const [salt, storedHash] = storedPassword.split(":");

  const hash = crypto
    .scryptSync(password, salt, 64)
    .toString("hex");

  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(storedHash, "hex")
  );
}

const sessions = new Map();
const complaintsMemory = [];

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
    const encodedPath = objectPath
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
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET belum dikonfigurasi");
  }

  const payload = Buffer.from(
    JSON.stringify({
      ...session,
      createdAt: Date.now()
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function getSession(req) {
  const token = getToken(req);
  if (!token || !process.env.SESSION_SECRET) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;

  const expectedSignature = crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;

    if (
      !session.createdAt ||
      !Number.isFinite(session.createdAt) ||
      Date.now() - session.createdAt < 0 ||
      Date.now() - session.createdAt > SESSION_MAX_AGE
    ) {
      return null;
    }

    if (session.role === "admin" && session.id === "admin") {
      return session;
    }

    if (
      session.role === "warga" &&
      session.wargaId &&
      String(session.id) === String(session.wargaId)
    ) {
      return session;
    }

    return null;
  } catch {
    return null;
  }
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

  if (!session || session.role !== "admin") {
    return res.status(403).json({
      ok: false,
      message: "Akses khusus Ketua RT"
    });
  }

  req.session = session;
  next();
}



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

/* DAFTAR WARGA */
app.post("/api/register-warga", async (req, res) => {
  try {
   const {
  no_hp,
  password,
  nama_lengkap,
  nik,
  no_kk,
  alamat,
  hubungan_keluarga
} = req.body;
    if (
  !no_hp ||
  !password ||
  !nama_lengkap ||
  !no_kk ||
  !alamat ||
  !hubungan_keluarga
) {
  return res.status(400).json({
    ok: false,
    message: "Semua data wajib diisi"
  });
}

if (
  hubungan_keluarga !== "Anak" &&
  !nik
) {
  return res.status(400).json({
    ok: false,
    message: "NIK wajib diisi untuk hubungan ini"
  });
}

    const existing = await supabaseRequest("warga", {
      query:
        `select=id` +
        `&no_hp=eq.${encodeURIComponent(no_hp)}` +
        `&limit=1`
    });

    if (Array.isArray(existing) && existing.length) {
      return res.status(409).json({
        ok: false,
        message: "Nomor HP sudah terdaftar"
      });
    }
    const nikExisting = await supabaseRequest("warga", {
  query:
    `select=id` +
    `&nik=eq.${encodeURIComponent(nik)}` +
    `&limit=1`
});

if (nik && Array.isArray(nikExisting) && nikExisting.length) {
  return res.status(409).json({
    ok: false,
    message: "NIK sudah terdaftar sebagai warga"
  });
}
const keluargaExisting = await supabaseRequest("keluarga", {
  query:
    `select=id,kepala_keluarga` +
    `&no_kk=eq.${encodeURIComponent(no_kk)}` +
    `&limit=1`
});

let keluarga_id = null;

if (Array.isArray(keluargaExisting) && keluargaExisting.length) {
  if (hubungan_keluarga === "Kepala Keluarga") {
    return res.status(400).json({
      ok: false,
      message: "No. KK tersebut sudah memiliki Kepala Keluarga"
    });
  }

  keluarga_id = keluargaExisting[0].id;
} else {
  if (hubungan_keluarga !== "Kepala Keluarga") {
    return res.status(400).json({
      ok: false,
      message: "Untuk No. KK baru, pendaftar pertama harus menjadi Kepala Keluarga"
    });
  }

  const keluargaBaru = await supabaseRequest("keluarga", {
    method: "POST",
    body: {
      no_kk,
      kepala_keluarga: nama_lengkap,
      alamat,
      rt: "04",
      rw: "01"
    }
  });

  const keluargaRow = Array.isArray(keluargaBaru)
    ? keluargaBaru[0]
    : keluargaBaru;

  keluarga_id = keluargaRow.id;
}
    const data = await supabaseRequest("warga", {
      method: "POST",
    body: {
  no_hp,
  password: hashPassword(password),
  nama_lengkap,
  nik: nik || null,
  no_kk,
  alamat,
  hubungan_keluarga,
   keluarga_id,
  status_warga: "menunggu_verifikasi"
}
    });

    return res.json({
      ok: true,
      message: "Pendaftaran warga berhasil",
      user: Array.isArray(data) ? data[0] : data
    });
  } catch (error) {
    console.error("REGISTER WARGA ERROR:", error);

    return res.status(500).json({
      ok: false,
      message: "Gagal mendaftarkan warga"
    });
  }
});
/* LOGIN */
app.post("/api/login", async (req, res) => {
  try {
    const { username, password, role } = req.body;
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
 
const token = createSessionToken({
  id: warga.id,
  wargaId: warga.id,
  username: warga.no_hp,
  role: "warga",
  nama: warga.nama_lengkap
});


  res.setHeader(
    "Set-Cookie",
    `rt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax`
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
   if (!ADMIN_PASSWORD) {
  return res.status(500).json({
    ok: false,
    message: "Login belum dikonfigurasi"
  });
} 
    if (
      username !== ADMIN_USER ||
      password !== ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        ok: false,
        message: "Username atau password salah"
      });
    }

 
const token = createSessionToken({
  id: "admin",
  username,
  role: "admin"
});

    res.setHeader(
      "Set-Cookie",
     `rt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax`
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
    console.error("LOGIN ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal masuk aplikasi"
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
      role: req.session.role
    }
  });
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
      complaints: complaintsMemory.length,
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
        "select=id,foto_profil,nik,no_kk,nama_lengkap,jenis_kelamin,tempat_lahir,tanggal_lahir,alamat,rt,rw,status_perkawinan,pekerjaan,no_hp,status_hunian,status_warga,hubungan_keluarga,keluarga_id,created_at&order=nama_lengkap.asc"
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
      data: row
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
      data: row
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
      data: row
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
      "hubungan_keluarga"
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
      data: row
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
        "select=id,nik,no_kk,nama_lengkap,jenis_kelamin,tempat_lahir,tanggal_lahir,alamat,rt,rw,status_perkawinan,pekerjaan,no_hp,status_warga,created_at&order=nama_lengkap.asc"
    });

    const rows = Array.isArray(data) ? data : [];

    const header = [
      "No",
      "NIK",
      "No KK",
      "Nama Lengkap",
      "Jenis Kelamin",
      "Tempat Lahir",
      "Tanggal Lahir",
      "Alamat",
      "RT",
      "RW",
      "Status Perkawinan",
      "Pekerjaan",
      "No HP",
      "Status Warga",
      "Tanggal Terdaftar"
    ];

    const csvRows = rows.map((row, index) => [
      index + 1,
      row.nik || "",
      row.no_kk || "",
      row.nama_lengkap || "",
      row.jenis_kelamin || "",
      row.tempat_lahir || "",
      row.tanggal_lahir || "",
      row.alamat || "",
      row.rt || "",
      row.rw || "",
      row.status_perkawinan || "",
      row.pekerjaan || "",
      row.no_hp || "",
      row.status_warga || "",
      row.created_at || ""
    ]);

const csv = [
  header,
  ...csvRows
]

       
      .map(row =>
        row.map(value =>
          '"' + String(value ?? "").replace(/"/g, '""') + '"'
        ).join(",")
      )
      .join("\r\n");
    res.setHeader(
      "Content-Type",
      "text/csv; charset=utf-8"
    );

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="data-warga-rt-kita.csv"'
    );

    res.send("\uFEFF" + csv);

  } catch (error) {
    console.error("EXPORT WARGA ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal export data warga"
    });
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
        ...row,
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
      const ekstensi = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp"
      }[req.file.mimetype];

      if (!ekstensi) {
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
          "Content-Type": req.file.mimetype,
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
      data: row
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
app.get("/api/cash", requireAdmin, async (req, res) => {
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
  requireAdmin,
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

      const signatures = {
        "image/jpeg": [0xff, 0xd8, 0xff],
        "image/png": [0x89, 0x50, 0x4e, 0x47],
        "image/webp": [0x52, 0x49, 0x46, 0x46]
      };

      const signature = signatures[contentType];

      if (!signature.every((byte, index) => req.body[index] === byte)) {
        return res.status(400).json({
          ok: false,
          message: "Isi file tidak sesuai dengan format gambar"
        });
      }

      if (
        contentType === "image/webp" &&
        req.body.toString("ascii", 8, 12) !== "WEBP"
      ) {
        return res.status(400).json({
          ok: false,
          message: "File WebP tidak valid"
        });
      }

      const extension = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp"
      }[contentType];

      
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


/* LIHAT BUKTI PENGELUARAN - KETUA RT */
app.get("/api/cash/proof/:id", requireLogin, async (req, res) => {
  try {
    const id = String(req.params.id || "");

    if (!/^\d+$/.test(id)) {
      return res.status(400).json({
        ok: false,
        message: "ID transaksi tidak valid"
      });
    }

    const data = await supabaseRequest("kas_rt", {
      query:
        "select=id,bukti_path" +
        `&id=eq.${encodeURIComponent(id)}&limit=1`
    });

    const row = Array.isArray(data) ? data[0] : null;

    if (!row || !row.bukti_path) {
      return res.status(404).json({
        ok: false,
        message: "Bukti pengeluaran tidak ditemukan"
      });
    }

    const path = String(row.bukti_path);

    if (!/^\d+-bukti\.(jpg|png|webp)$/.test(path)) {
      return res.status(400).json({
        ok: false,
        message: "Lokasi bukti tidak valid"
      });
    }

    const response = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/bukti-pengeluaran/${path}`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          expiresIn: 300
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.signedURL) {
      console.error("SIGNED PROOF ERROR:", result);

      return res.status(500).json({
        ok: false,
        message: "Gagal membuat tautan bukti"
      });
    }

    return res.json({
      ok: true,
      url: `${SUPABASE_URL}/storage/v1${result.signedURL}`
    });
  } catch (error) {
    console.error("VIEW PROOF ERROR:", error);

    return res.status(500).json({
      ok: false,
      message: "Gagal membuka bukti pengeluaran"
    });
  }
});



/* TAMBAH TRANSAKSI KAS - KETUA RT */
app.post("/api/cash", requireAdmin, async (req, res) => {
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

    // Ambil riwayat dana pada kategori yang dipilih.
    const riwayat = await supabaseRequest("kas_rt", {
      query:
        "select=jenis,jumlah,kategori" +
        `&kategori=eq.${encodeURIComponent(kategori)}`
    });

    let saldoKategori = 0;

    if (Array.isArray(riwayat)) {
      for (const row of riwayat) {
        const nilai = Number(row.jumlah) || 0;
        const jenisLama = String(row.jenis || "").toLowerCase();

        if (jenisLama.includes("keluar")) {
          saldoKategori -= nilai;
        } else {
          saldoKategori += nilai;
        }
      }
    }

    if (jenis === "keluar" && jumlah > saldoKategori) {
      return res.status(400).json({
        ok: false,
        message:
          `Saldo kategori ${kategori} tidak mencukupi. ` +
          `Saldo tersedia Rp${Math.max(0, saldoKategori).toLocaleString("id-ID")}.`
      });
    }

    const transaksi = {
      tanggal: date,
      jenis,
      kategori,
      keterangan,
      jumlah
    };

    if (jenis === "keluar") {
      transaksi.bukti_path = proof;
      transaksi.bukti_hash = buktiHash;
    }

    const data = await supabaseRequest("kas_rt", {
      method: "POST",
      body: transaksi
    });

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
app.get("/api/cash/export", requireAdmin, async (req, res) => {
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
    '"' + String(value ?? "").replace(/"/g, '""') + '"'
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

    res.send("\uFEFF" + csv);

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
app.get("/api/letters", requireAdmin, async (req, res) => {
  try {
    const data = await supabaseRequest("pengajuan_surat", {
      query:
        "select=id,warga_id,jenis_surat,keperluan,status,catatan,created_at&order=created_at.desc"
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
        nama: w?.nama_lengkap || "",
        nik: w?.nik || "",
        alamat: w?.alamat || "",
        no_hp: w?.no_hp || ""
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
        "select=id,warga_id,jenis_surat,keperluan,status,catatan,created_at" +
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
    const residents = await supabaseRequest("warga", {
      query:
        "select=id,nama_lengkap,nik,no_kk,alamat,jenis_kelamin,tempat_lahir,tanggal_lahir,pekerjaan" +
        "&id=eq." + encodeURIComponent(letter.warga_id)
    });

    if (!Array.isArray(residents) || residents.length === 0) {
      return res.status(404).json({
        ok: false,
        message: "Data warga pemilik surat tidak ditemukan"
      });
    }
  
    const warga = residents[0];
    const clean = (value) =>
      value == null ? "" : String(value).trim();
    const PDFDocument = require("pdfkit");

    const fs = require("fs");
    const path = require("path");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="surat-${id}.pdf"`
    );

    const doc = new PDFDocument({
      size: "A4",
      margin: 55
    });

    doc.pipe(res);

  
   

    // TEMPLATE SURAT TBK — LATAR A4 PENUH
    const kopTemplatePath = path.join(
      __dirname,
      "contoh kop surat kosong tbk.png"
    );

    if (fs.existsSync(kopTemplatePath)) {
      doc.image(kopTemplatePath, 0, 0, {
        width: doc.page.width,
        height: doc.page.height
      });
    } else {
      console.error("GAMBAR TEMPLATE KOP SURAT TIDAK DITEMUKAN");
    }
    // ISI SURAT DI AREA DALAM BINGKAI
    doc.y = 175;
    doc.fillColor("#000000");

    doc.font("Helvetica-Bold")
      .fontSize(13)
      .text(clean(letter.jenis_surat).toUpperCase(), 65, doc.y, {
        width: 465,
        align: "center"
      });

   doc.moveDown(0.4);

const tanggalSurat = new Date(letter.created_at || Date.now());

const bulanRomawi = [
  "I", "II", "III", "IV", "V", "VI",
  "VII", "VIII", "IX", "X", "XI", "XII"
][tanggalSurat.getMonth()];

const nomorSurat =
  String(id).padStart(3, "0") +
  "/RT.04/RW.01/" +
  String(tanggalSurat.getMonth() + 1).padStart(2, "0") +
  "/" + bulanRomawi +
  "/" + tanggalSurat.getFullYear();

doc.font("Helvetica")
  .fontSize(10)
  .text("Nomor: " + nomorSurat, {
    width: 465,
    align: "center"
  });

doc.moveDown(1);
    doc.fontSize(10)
      .text("Yang bertanda tangan di bawah ini menerangkan bahwa:", {
        width: 465
      });

  
doc.moveDown(0.6);

const identity = [
  ["Nama", clean(warga.nama_lengkap)],
  ["NIK", clean(warga.nik) || "-"],
  ["Nomor KK", clean(warga.no_kk) || "-"],
  ["Tempat/Tanggal Lahir", [
    clean(warga.tempat_lahir),
    warga.tanggal_lahir
      ? new Date(warga.tanggal_lahir + "T00:00:00").toLocaleDateString("id-ID", {
          day: "2-digit",
          month: "long",
          year: "numeric"
        })
      : ""
  ].filter(Boolean).join(", ") || "-"],
  ["Jenis Kelamin", clean(warga.jenis_kelamin) || "-"],
  ["Pekerjaan", clean(warga.pekerjaan) || "-"],
  ["Alamat", clean(warga.alamat) || "-"]
];

identity.forEach(([label, value]) => {
  const y = doc.y;
  doc.font("Helvetica").fontSize(9);
  doc.text(label, 70, y, { width: 125 });
  doc.text(":", 198, y, { width: 10 });
  doc.text(value, 215, y, { width: 300 });
  doc.moveDown(0.35);
});

doc.moveDown(0.6);


const jenisSurat = clean(letter.jenis_surat)
  .toLowerCase()
  .replace(/[_-]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const keperluan = clean(letter.keperluan) || "-";

let isiSurat = "";
let penutupSurat = "";

if (
  jenisSurat.includes("tidak mampu") ||
  jenisSurat.includes("sktm")
) {
  isiSurat =
    "Berdasarkan permohonan yang disampaikan, surat ini merupakan surat pengantar dari lingkungan RT untuk keperluan pengajuan Surat Keterangan Tidak Mampu (SKTM). Surat ini tidak menyatakan atau menetapkan status ekonomi pemohon dan tidak menggantikan surat keterangan yang diterbitkan oleh kelurahan atau instansi berwenang.";

  penutupSurat =
    "Penilaian dan penerbitan Surat Keterangan Tidak Mampu dilakukan oleh instansi berwenang sesuai ketentuan yang berlaku.";
} else if (jenisSurat.includes("domisili sementara")) {
  isiSurat =
    "Surat ini merupakan surat pengantar untuk permohonan keterangan domisili sementara berdasarkan alamat dan keterangan yang disampaikan oleh pemohon. Surat ini belum merupakan penetapan domisili resmi dan dapat digunakan sebagai dokumen pengantar untuk proses verifikasi oleh instansi berwenang.";

  penutupSurat =
    "Keterangan domisili sementara yang resmi mengikuti hasil verifikasi dan ketentuan instansi berwenang.";
} else if (jenisSurat.includes("domisili")) {
  isiSurat =
    "Surat ini merupakan surat pengantar untuk permohonan keterangan domisili berdasarkan alamat yang tercantum dalam data pemohon. Kesesuaian alamat dan status domisili perlu diverifikasi sesuai prosedur yang berlaku.";

  penutupSurat =
    "Penerbitan keterangan domisili resmi mengikuti verifikasi dan ketentuan instansi berwenang.";
} else if (jenisSurat.includes("skck")) {
  isiSurat =
    "Surat ini merupakan surat pengantar dari lingkungan RT untuk keperluan permohonan Surat Keterangan Catatan Kepolisian (SKCK). Surat pengantar ini bukan SKCK dan tidak menyatakan hasil pemeriksaan catatan kepolisian pemohon.";

  penutupSurat =
    "Penerbitan SKCK dan pemeriksaan persyaratannya merupakan kewenangan Kepolisian Republik Indonesia.";
} else {
  isiSurat =
    "Surat ini merupakan surat pengantar umum berdasarkan permohonan warga untuk keperluan sebagaimana tercantum di bawah ini. Informasi dalam surat disusun berdasarkan data yang tersedia dan keterangan yang disampaikan oleh pemohon.";

  penutupSurat =
    "Penggunaan surat ini mengikuti tujuan permohonan serta persyaratan instansi atau pihak penerima yang bersangkutan.";
}

doc.font("Helvetica")
  .fontSize(10)
  .text("Dengan ini diterangkan bahwa:", {
    width: 465,
    align: "justify",
    lineGap: 2
  });

doc.moveDown(0.5);

doc.text(isiSurat, {
  width: 465,
  align: "justify",
  lineGap: 3
});

doc.moveDown(0.6);

doc.font("Helvetica-Bold")
  .fontSize(9)
  .text("Keperluan:", { width: 465 });

doc.font("Helvetica")
  .fontSize(10)
  .text(keperluan, {
    width: 465,
    align: "justify",
    lineGap: 2
  });

doc.moveDown(0.6);

doc.font("Helvetica")
  .fontSize(9)
  .text(
    "Demikian surat pengantar ini dibuat berdasarkan permohonan warga. " +
    penutupSurat,
    {
      width: 465,
      align: "justify",
      lineGap: 2
    }
  );



 // AREA PENGESAHAN — DRAF BELUM DISAHKAN
const signX = 335;
const signY = Math.min(Math.max(doc.y + 20, 475), 570);

doc.font("Helvetica")
  .fontSize(9)
  .fillColor("#000000")
  .text(
    "Bekasi, " + new Date(
      letter.created_at || Date.now()
    ).toLocaleDateString("id-ID", {
      day: "2-digit",
      month: "long",
      year: "numeric"
    }),
    signX,
    signY,
    {
      width: 180,
      align: "center"
    }
  );

doc.text("Pengurus RT 004 / RW 01", signX, signY + 18, {
  width: 180,
  align: "center"
});

doc.moveTo(signX + 25, signY + 85)
  .lineTo(signX + 155, signY + 85)
  .lineWidth(0.7)
  .strokeColor("#777777")
  .stroke();

doc.font("Helvetica")
  .fontSize(8)
  .fillColor("#B91C1C")
  .text("DRAF — BELUM DISAHKAN", signX, signY + 95, {
    width: 180,
    align: "center"
  });

doc.end();

  } catch (error) {
    console.error("DOWNLOAD LETTER PDF ERROR:", error);

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        message: "Gagal membuat PDF surat"
      });
    } else {
      res.end();
    }
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
app.patch("/api/letters/:id", requireAdmin, async (req, res) => {
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
      query: `select=id,status&id=eq.${id}`
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

    res.json({
      ok: true,
      message: status === "disetujui"
        ? "Surat berhasil disetujui"
        : "Surat berhasil ditolak",
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
app.post("/api/announcements", requireAdmin, async (req, res) => {
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
  let tersimpan = [];

  try {
    // Pengaduan disimpan permanen di tabel notifikasi (jenis = pengaduan).
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
      try {
        const warga = await supabaseRequest("warga", {
          query: `select=id,nama_lengkap&id=in.(${ids.join(",")})`
        });
        (Array.isArray(warga) ? warga : []).forEach(w =>
          namaMap.set(String(w.id), w.nama_lengkap || "")
        );
      } catch (err) {
        console.error("PENGADUAN NAMA ERROR:", err?.message || err);
      }
    }

    tersimpan = rows.map(r => ({
      id: r.id,
      warga_id: r.referensi_id,
      title: r.judul,
      content: r.pesan,
      nama: namaMap.get(String(r.referensi_id)) || "",
      created_at: r.dibuat_pada,
      status: r.sudah_dibaca ? "dibaca" : "baru"
    }));
  } catch (error) {
    console.error("PENGADUAN GET ERROR:", error?.message || error);
  }

  res.json([...complaintsMemory, ...tersimpan]);
});

/* PENGADUAN - WARGA */
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
  }

  // Cadangan bila penyimpanan database gagal.
  const complaint = {
    id: crypto.randomUUID(),
    warga_id: req.session.wargaId,
    title,
    content,
    nama: req.session.nama || "",
    created_at: new Date().toISOString(),
    status: "baru"
  };

  complaintsMemory.unshift(complaint);

  res.json({
    ok: true,
    data: complaint
  });
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
        "select=id,warga_id,keluarga_id,bulan,status,total_amount" +
        `&keluarga_id=eq.${encodeURIComponent(String(warga.keluarga_id))}` +
        "&order=bulan.desc"
    });

    return res.json(Array.isArray(data) ? data : []);
  } catch (error) {
    console.error("MY IURAN ERROR:", error);

    return res.status(500).json({
      ok: false,
      message: "Gagal mengambil data iuran"
    });
  }
});


app.get("/api/iuran", requireAdmin, async (req, res) => {
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


/* BAYAR IURAN BEBERAPA BULAN SEKALIGUS */
app.post("/api/iuran/bayar-banyak", requireWarga, async (req, res) => {
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
        message: "Pilihan bulan tidak valid atau ada bulan yang dipilih dua kali."
      });
    }

    const dipilih = [...bulans].sort();
    const awalCatatan = "2026-10";

    if (dipilih[0] < awalCatatan) {
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
        "select=id,warga_id,keluarga_id,bulan,status,total_amount" +
        `&keluarga_id=eq.${encodeURIComponent(keluargaId)}` +
        "&order=bulan.asc"
    });

    const catatan = Array.isArray(dataLama) ? dataLama : [];
    const peta = new Map(
      catatan.map(row => [String(row.bulan).slice(0, 7), row])
    );

   
    // Tolak bulan yang sudah memiliki catatan pembayaran.
    for (const bulan of dipilih) {
      const record = peta.get(bulan);

      if (record?.status === "lunas") {
        return res.status(409).json({
          ok: false,
          message: `Iuran ${bulan} sudah lunas. Silakan periksa status iuran.`
        });
      }

      if (record) {
        return res.status(409).json({
          ok: false,
          message: `Iuran ${bulan} sudah diajukan dan masih menunggu verifikasi Ketua RT.`
        });
      }
    }

    // Periksa seluruh urutan bulan sejak awal pencatatan.
    const terakhir = dipilih[dipilih.length - 1];
    const bulanDipilih = new Set(dipilih);

    const mulai = new Date(2026, 9, 1);
    const akhir = new Date(
      Number(terakhir.slice(0, 4)),
      Number(terakhir.slice(5, 7)) - 1,
      1
    );

    for (
      let d = new Date(mulai);
      d <= akhir;
      d.setMonth(d.getMonth() + 1)
    ) {
      const bulan =
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

      const record = peta.get(bulan);

      if (record?.status === "lunas") {
        continue;
      }

      if (record) {
        return res.status(409).json({
          ok: false,
          message: `Iuran ${bulan} masih menunggu verifikasi. Selesaikan verifikasi sebelum mengajukan bulan berikutnya.`
        });
      }

      if (bulanDipilih.has(bulan)) {
        continue;
      }

      return res.status(409).json({
        ok: false,
        message: `Iuran ${bulan} masih belum lunas. Silakan pilih dan ajukan bulan tersebut terlebih dahulu sebelum membayar bulan berikutnya.`
      });
    }


    const rowsBaru = dipilih.map(bulan => ({
      warga_id: String(warga.id),
      keluarga_id: keluargaId,
      bulan: bulan + "-01",
      status: "menunggu_verifikasi",
      total_amount: 35000
    }));

    // Kirim semua baris dalam satu permintaan database.
    const hasil = await supabaseRequest("iuran_warga", {
      method: "POST",
      body: rowsBaru
    });

    const tersimpan = Array.isArray(hasil) ? hasil : [];

    if (tersimpan.length !== rowsBaru.length) {
      console.error("JUMLAH HASIL PEMBAYARAN TIDAK SESUAI.");
      return res.status(500).json({
        ok: false,
        message: "Hasil penyimpanan perlu diperiksa oleh Ketua RT."
      });
    }

    // Buat notifikasi admin untuk setiap bulan.
    for (const row of tersimpan) {
      try {
        await supabaseRequest("notifikasi", {
          method: "POST",
          body: {
            penerima_peran: "admin",
            judul: "Pembayaran Iuran Menunggu Verifikasi",
            pesan:
              `${warga.nama_lengkap || "Warga"} mengajukan iuran bulan ${String(row.bulan).slice(0, 7)}. Total Rp35.000. Menunggu verifikasi Ketua RT.`,
            jenis: "iuran",
            tautan: "/admin",
            referensi_id: row.id,
            sudah_dibaca: false
          }
        });
      } catch (err) {
        console.error("NOTIFIKASI IURAN ERROR:", err?.message || err);
      }
    }

    return res.json({
      ok: true,
      data: tersimpan,
      message: "Pengajuan iuran berhasil disimpan."
    });
  } catch (error) {
    console.error("BAYAR IURAN BANYAK ERROR:", error);

    return res.status(
      getSupabaseErrorCode(error) === "23505" ? 409 : 500
    ).json({
      ok: false,
      message: getSupabaseErrorCode(error) === "23505"
        ? "Ada pembayaran untuk salah satu bulan yang sudah tercatat. Muat ulang halaman dan periksa status iuran."
        : "Gagal menyimpan pengajuan iuran. Periksa kembali sebelum mencoba lagi."
    });
  }
});


/* BAYAR IURAN - WARGA: SATU KK SATU PEMBAYARAN PER BULAN */
app.post("/api/iuran/bayar", requireWarga, async (req, res) => {
  try {
    const inputBulan = String(req.body.bulan || "").slice(0, 7);

    if (!/^\d{4}-\d{2}$/.test(inputBulan)) {
      return res.status(400).json({
        ok: false,
        message: "Bulan iuran wajib diisi"
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
app.post("/api/iuran/verifikasi", requireAdmin, async (req, res) => {
  try {
    const id = req.body.id;

    if (!id) {
      return res.status(400).json({
        ok: false,
        message: "ID iuran wajib diisi"
      });
    }

    const existing = await supabaseRequest("iuran_warga", {
      query:
        "select=id,warga_id,bulan,status,total_amount" +
        `&id=eq.${encodeURIComponent(id)}` +
        "&limit=1"
    });

    if (!Array.isArray(existing) || !existing.length) {
      return res.status(404).json({
        ok: false,
        message: "Data iuran tidak ditemukan"
      });
    }

    const iuran = existing[0];

    // Cegah verifikasi ulang untuk pembayaran yang sudah lunas.
    if (iuran.status === "lunas") {
      return res.json({
        ok: true,
        message: "Iuran ini sudah lunas sebelumnya",
        data: iuran
      });
    }

    const dana = [
      { kategori: "Sampah", jumlah: 15000 },
      { kategori: "Keamanan", jumlah: 15000 },
      { kategori: "Kas RT", jumlah: 5000 }
    ];

    for (const item of dana) {
      const keterangan =
        `${item.kategori} dari iuran ${iuran.bulan} - iuran_id ${iuran.id}`;

      let kasExisting = await supabaseRequest("kas_rt", {
        query:
          "select=id,kategori" +
          `&keterangan=eq.${encodeURIComponent(keterangan)}` +
          "&limit=1"
      });

      if (!Array.isArray(kasExisting) || !kasExisting.length) {
        try {
          await supabaseRequest("kas_rt", {
            method: "POST",
            body: {
              tanggal: new Date().toISOString().slice(0, 10),
              jenis: "masuk",
              kategori: item.kategori,
              keterangan,
              jumlah: item.jumlah
            }
          });
        } catch (insertError) {
          if (getSupabaseErrorCode(insertError) !== "23505") {
            throw insertError;
          }

          kasExisting = await supabaseRequest("kas_rt", {
            query:
              "select=id,kategori" +
              `&keterangan=eq.${encodeURIComponent(keterangan)}` +
              "&limit=1"
          });

          if (!Array.isArray(kasExisting) || !kasExisting.length) {
            throw insertError;
          }
        }
      }

      if (
        Array.isArray(kasExisting) &&
        kasExisting.length &&
        !kasExisting[0].kategori
      ) {
        await supabaseRequest("kas_rt", {
          method: "PATCH",
          query: `id=eq.${encodeURIComponent(kasExisting[0].id)}`,
          body: { kategori: item.kategori }
        });
      }
    }

    const data = await supabaseRequest("iuran_warga", {
      method: "PATCH",
      query:
        `id=eq.${encodeURIComponent(id)}` +
        "&status=neq.lunas",
      body: {
        status: "lunas",
        diverifikasi_at: new Date().toISOString(),
        diverifikasi_oleh: req.session.adminUser || "Ketua RT"
      }
    });

    const row = Array.isArray(data) ? data[0] : data;

    if (!row || row.status !== "lunas") {
      return res.status(409).json({
        ok: false,
        message: "Status iuran tidak berhasil diperbarui. Periksa kembali data iuran."
      });
    }

    // Notifikasi warga setelah pembayaran berhasil diverifikasi.
    try {
      await supabaseRequest("notifikasi", {
        method: "POST",
        body: {
          penerima_peran: "warga",
          penerima_warga_id: Number(iuran.warga_id),
          judul: "Pembayaran Iuran Terverifikasi",
          pesan:
            `Pembayaran iuran bulan ${String(iuran.bulan).slice(0, 7)} ` +
            "sebesar Rp35.000 telah diverifikasi dan dinyatakan lunas.",
          jenis: "iuran",
          tautan: "/",
          referensi_id: iuran.id,
          sudah_dibaca: false
        }
      });
    } catch (notifError) {
      console.error("NOTIFIKASI VERIFIKASI IURAN ERROR:", notifError);
    }

    return res.json({
      ok: true,
      message: "Iuran berhasil diverifikasi",
      data: row
    });
  } catch (error) {
    console.error("VERIFIKASI IURAN ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: "Gagal memverifikasi iuran"
    });
  }
});

/* HEALTH CHECK */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "RT Kita berjalan"
  });
});

/* FILE FRONTEND */
app.use(express.static(__dirname, { index: false }));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

module.exports = app;
