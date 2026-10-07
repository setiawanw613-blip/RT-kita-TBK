const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

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

function getToken(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/rt_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function getSession(req) {
  const token = getToken(req);
  return token ? sessions.get(token) : null;
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

function requireWarga(req, res, next) {
  const session = getSession(req);

  if (!session || session.role !== "warga") {
    return res.status(403).json({
      ok: false,
      message: "Akses khusus warga"
    });
  }

  req.session = session;
  next();
}

/* LOGIN */
app.post("/api/login", async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (role === "warga") {
      if (!username || !password) {
        return res.status(400).json({
          ok: false,
          message: "NIK dan No. KK wajib diisi"
        });
      }

      const data = await supabaseRequest("warga", {
        query:
          `select=id,nik,no_kk,nama_lengkap,alamat,no_hp,status_warga` +
          `&nik=eq.${encodeURIComponent(username)}` +
          `&no_kk=eq.${encodeURIComponent(password)}` +
          `&limit=1`
      });

      if (!Array.isArray(data) || !data.length) {
        return res.status(401).json({
          ok: false,
          message: "NIK atau No. KK salah"
        });
      }

      const warga = data[0];
      const token = crypto.randomBytes(32).toString("hex");

      sessions.set(token, {
        id: warga.id,
        wargaId: warga.id,
        username: warga.nik,
        role: "warga",
        nama: warga.nama_lengkap,
        createdAt: Date.now()
      });

      res.setHeader(
        "Set-Cookie",
        `rt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
      );

      return res.json({
        ok: true,
        user: {
          id: warga.id,
          username: warga.nik,
          nama: warga.nama_lengkap,
          role: "warga"
        }
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

    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, {
      id: "admin",
      username,
      role: "admin",
      createdAt: Date.now()
    });

    res.setHeader(
      "Set-Cookie",
      `rt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
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
  const token = getToken(req);

  if (token) {
    sessions.delete(token);
  }

  res.setHeader(
    "Set-Cookie",
    "rt_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax"
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

/* DATA WARGA - KETUA RT */
app.get("/api/residents", requireAdmin, async (req, res) => {
  try {
    const data = await supabaseRequest("warga", {
      query:
        "select=id,nik,no_kk,nama_lengkap,jenis_kelamin,tempat_lahir,tanggal_lahir,alamat,rt,rw,status_perkawinan,pekerjaan,no_hp,status_warga,created_at&order=nama_lengkap.asc"
    });

    const rows = Array.isArray(data)
      ? data.map(row => ({
          ...row,
          nama: row.nama_lengkap
        }))
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
          `"${String(value).replace(/"/g, '""')}"`
        ).join(",")
      )
      .join("\n");

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

/* DATA SAYA - WARGA */
app.get("/api/my-data", requireWarga, async (req, res) => {
  try {
    const data = await supabaseRequest("warga", {
      query:
        `select=id,nik,no_kk,nama_lengkap,jenis_kelamin,tempat_lahir,tanggal_lahir,alamat,rt,rw,status_perkawinan,pekerjaan,no_hp,status_warga,created_at` +
        `&id=eq.${encodeURIComponent(req.session.wargaId)}` +
        `&limit=1`
    });

    const row = Array.isArray(data) ? data[0] : data;

    res.json(
      row
        ? {
            ...row,
            nama: row.nama_lengkap
          }
        : null
    );
  } catch (error) {
    console.error("MY DATA ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil data warga"
    });
  }
});

/* KAS - KETUA RT */
app.get("/api/cash", requireAdmin, async (req, res) => {
  try {
    const data = await supabaseRequest("kas_rt", {
      query:
        "select=id,tanggal,jenis,keterangan,jumlah,created_at&order=created_at.desc"
    });

    const rows = Array.isArray(data)
      ? data.map(row => ({
          ...row,
          description: row.keterangan,
          type: row.jenis,
          amount: row.jumlah
        }))
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
/* EXPORT KAS RT */
app.get("/api/cash/export", requireAdmin, async (req, res) => {
  try {
    const data = await supabaseRequest("kas_rt", {
      query:
        "select=id,tanggal,jenis,keterangan,jumlah,created_at&order=created_at.desc"
    });

    const rows = Array.isArray(data) ? data : [];

    const header = [
      "No",
      "Tanggal",
      "Jenis",
      "Keterangan",
      "Jumlah",
      "Tanggal Dibuat"
    ];

    const csvRows = rows.map((row, index) => [
      index + 1,
      row.tanggal || "",
      row.jenis || "",
      row.keterangan || "",
      row.jumlah || 0,
      row.created_at || ""
    ]);

    const csv = [
      header,
      ...csvRows
    ]
      .map(row =>
        row.map(value =>
          `"${String(value).replace(/"/g, '""')}"`
        ).join(",")
      )
      .join("\n");

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
        "select=id,tanggal,jenis,keterangan,jumlah,created_at&order=created_at.desc"
    });

    const rows = Array.isArray(data) ? data : [];

    const result = [];

    for (const row of rows) {
      let namaWarga = "";
      let periode = "";
      let totalIuran = 0;
      let statusIuran = "";
      let diverifikasiAt = "";
      let diverifikasiOleh = "";
      let kategori = "Lainnya";

      const keterangan = row.keterangan || "";

      const match = keterangan.match(/iuran_id\s+(\d+)/i);

      if (match) {
        const iuranId = match[1];

        const iuranData = await supabaseRequest("iuran_warga", {
          query:
            `select=id,warga_id,bulan,total_amount,status,diverifikasi_at,diverifikasi_oleh` +
            `&id=eq.${encodeURIComponent(iuranId)}` +
            `&limit=1`
        });

        if (Array.isArray(iuranData) && iuranData.length) {
          const iuran = iuranData[0];

          periode = iuran.bulan || "";
          totalIuran = Number(iuran.total_amount) || 0;
          statusIuran = iuran.status || "";
          diverifikasiAt = iuran.diverifikasi_at || "";
          diverifikasiOleh = iuran.diverifikasi_oleh || "";
          kategori = "Iuran Warga";

          if (iuran.warga_id) {
            const wargaData = await supabaseRequest("warga", {
              query:
                `select=id,nama_lengkap` +
                `&id=eq.${encodeURIComponent(iuran.warga_id)}` +
                `&limit=1`
            });

            if (Array.isArray(wargaData) && wargaData.length) {
              namaWarga = wargaData[0].nama_lengkap || "";
            }
          }
        }
      }

      if (row.jenis === "masuk" && !namaWarga) {
        kategori = "Pemasukan Lainnya";
      }

      if (row.jenis === "keluar") {
        kategori = "Pengeluaran";
      }

      result.push({
        id: row.id,
        tanggal: row.tanggal || "",
        waktu: row.created_at || "",
        type: row.jenis === "keluar" ? "keluar" : "masuk",
        amount: Number(row.jumlah) || 0,
        description: keterangan,
        nama_warga: namaWarga,
        periode: periode,
        total_iuran: totalIuran,
        status_iuran: statusIuran,
        diverifikasi_at: diverifikasiAt,
        diverifikasi_oleh: diverifikasiOleh,
        kategori: kategori
      });
    }

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

    const rows = Array.isArray(data)
      ? data.map(row => ({
          ...row,
          type: row.jenis_surat,
          purpose: row.keperluan,
          nama: ""
        }))
      : [];

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

/* SURAT SAYA - WARGA */
app.get("/api/my-letters", requireWarga, async (req, res) => {
  try {
    const data = await supabaseRequest("pengajuan_surat", {
      query:
        `select=id,warga_id,jenis_surat,keperluan,status,catatan,created_at` +
        `&warga_id=eq.${encodeURIComponent(req.session.wargaId)}` +
        `&order=created_at.desc`
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
      message: "Gagal mengambil surat saya"
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
app.get("/api/complaints", requireAdmin, (req, res) => {
  res.json(complaintsMemory);
});

/* PENGADUAN - WARGA */
app.post("/api/complaints", requireWarga, (req, res) => {
  const {
    title,
    content
  } = req.body;

  if (!title || !content) {
    return res.status(400).json({
      ok: false,
      message: "Judul dan isi pengaduan wajib diisi"
    });
  }

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
    const data = await supabaseRequest("iuran_warga", {
      query:
        `select=*&warga_id=eq.${encodeURIComponent(req.session.wargaId)}` +
        `&order=bulan.desc`
    });

    res.json(Array.isArray(data) ? data : []);
  } catch (error) {
    console.error("MY IURAN ERROR:", error);
    res.status(500).json({
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

    res.json(Array.isArray(data) ? data : []);
  } catch (error) {
    console.error("IURAN ERROR:", error);
    res.status(500).json({
      ok: false,
      message: "Gagal mengambil data iuran"
    });
  }
});
/* BAYAR IURAN - WARGA */
app.post("/api/iuran/bayar", requireWarga, async (req, res) => {
  try {
    const bulan = String(req.body.bulan || "").slice(0, 7) + "-01";
    if (!bulan) {
      return res.status(400).json({
        ok: false,
        message: "Bulan iuran wajib diisi"
      });
    }

    const existing = await supabaseRequest("iuran_warga", {
      query:
        `select=id,status,total_amount` +
        `&warga_id=eq.${encodeURIComponent(req.session.wargaId)}` +
        `&bulan=eq.${encodeURIComponent(bulan)}` +
        `&limit=1`
    });

    if (Array.isArray(existing) && existing.length) {
      return res.json({
        ok: true,
        data: existing[0]
      });
    }

    const data = await supabaseRequest("iuran_warga", {
      method: "POST",
      body: {
        warga_id: req.session.wargaId,
        bulan,
        status: "menunggu_verifikasi",
        total_amount: 35000
      }
    });

    const row = Array.isArray(data) ? data[0] : data;

    res.json({
      ok: true,
      data: row
    });
  } catch (error) {
    console.error("BAYAR IURAN ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal menyimpan pembayaran iuran"
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
        `select=id,warga_id,bulan,status,total_amount` +
        `&id=eq.${encodeURIComponent(id)}` +
        `&limit=1`
    });

    if (!Array.isArray(existing) || !existing.length) {
      return res.status(404).json({
        ok: false,
        message: "Data iuran tidak ditemukan"
      });
    }

    const iuran = existing[0];

    const keteranganKas =
      `Kas RT dari iuran ${iuran.bulan} - iuran_id ${iuran.id}`;

    const kasExisting = await supabaseRequest("kas_rt", {
      query:
        `select=id` +
        `&keterangan=eq.${encodeURIComponent(keteranganKas)}` +
        `&limit=1`
    });

    if (!Array.isArray(kasExisting) || !kasExisting.length) {
      await supabaseRequest("kas_rt", {
        method: "POST",
        body: {
          tanggal: new Date().toISOString().slice(0, 10),
          jenis: "masuk",
          keterangan: keteranganKas,
          jumlah: 5000
        }
      });
    }

    const data = await supabaseRequest("iuran_warga", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(id)}`,
      body: {
        status: "lunas",
        diverifikasi_at: new Date().toISOString(),
        diverifikasi_oleh: req.session.adminUser || "Ketua RT"
      }
    });

    const row = Array.isArray(data) ? data[0] : data;

    res.json({
      ok: true,
      data: row
    });
  } catch (error) {
    console.error("VERIFIKASI IURAN ERROR:", error);

    res.status(500).json({
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
