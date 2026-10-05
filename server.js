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

function supabaseRequest(table, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Supabase belum terhubung");
  }

  const {
    method = "GET",
    query = "",
    body
  } = options;

  const url =
    `${SUPABASE_URL}/rest/v1/${table}` +
    (query ? `?${query}` : "");

  return fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "GET"
        ? "return=representation"
        : "return=representation"
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(async response => {
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
  });
}

function getToken(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/rt_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function requireLogin(req, res, next) {
  const token = getToken(req);

  if (!token || !sessions.has(token)) {
    return res.status(401).json({
      ok: false,
      message: "Belum login"
    });
  }

  next();
}

/* LOGIN */
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

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
    username,
    createdAt: Date.now()
  });

  res.setHeader(
    "Set-Cookie",
    `rt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
  );

  res.json({
    ok: true,
    username
  });
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
    username: ADMIN_USER
  });
});

/* DASHBOARD */
app.get("/api/dashboard", requireLogin, async (req, res) => {
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

    let saldo = 0;

    if (Array.isArray(kas)) {
      for (const item of kas) {
        const jumlah = Number(item.jumlah) || 0;

        if (
          String(item.jenis || "").toLowerCase() === "pengeluaran"
        ) {
          saldo -= jumlah;
        } else {
          saldo += jumlah;
        }
      }
    }

    res.json({
      ok: true,
      warga: Array.isArray(warga) ? warga.length : 0,
      surat: Array.isArray(surat) ? surat.length : 0,
      pengaduan: 0,
      saldo
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil dashboard"
    });
  }
});

/* DATA WARGA - AMBIL */
app.get("/api/residents", requireLogin, async (req, res) => {
  try {
    const data = await supabaseRequest("warga", {
      query:
        "select=id,nik,no_kk,nama_lengkap,jenis_kelamin,tempat_lahir,tanggal_lahir,alamat,rt,rw,status_perkawinan,pekerjaan,no_hp,status_warga,created_at&order=nama_lengkap.asc"
    });

    res.json({
      ok: true,
      data: Array.isArray(data) ? data : []
    });
  } catch (error) {
    console.error("RESIDENTS ERROR:", error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil data warga"
    });
  }
});

/* DATA WARGA - TAMBAH */
app.post("/api/residents", requireLogin, async (req, res) => {
  try {
    const data = await supabaseRequest("warga", {
      method: "POST",
      body: req.body
    });

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      message: "Gagal menambah warga"
    });
  }
});

/* DATA WARGA - EDIT */
app.put("/api/residents/:id", requireLogin, async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);

    const data = await supabaseRequest("warga", {
      method: "PATCH",
      query: `id=eq.${id}`,
      body: req.body
    });

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengubah data warga"
    });
  }
});

/* PENGUMUMAN */
app.get("/api/announcements", requireLogin, async (req, res) => {
  try {
    const data = await supabaseRequest("pengumuman", {
      query: "select=*&order=created_at.desc"
    });

    res.json({
      ok: true,
      data: Array.isArray(data) ? data : []
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil pengumuman"
    });
  }
});

app.post("/api/announcements", requireLogin, async (req, res) => {
  try {
    const data = await supabaseRequest("pengumuman", {
      method: "POST",
      body: req.body
    });

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      message: "Gagal membuat pengumuman"
    });
  }
});

/* SURAT */
app.get("/api/letters", requireLogin, async (req, res) => {
  try {
    const data = await supabaseRequest("pengajuan_surat", {
      query: "select=*&order=id.desc"
    });

    res.json({
      ok: true,
      data: Array.isArray(data) ? data : []
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil data surat"
    });
  }
});

/* KAS */
app.get("/api/cash", requireLogin, async (req, res) => {
  try {
    const data = await supabaseRequest("kas_rt", {
      query: "select=*&order=id.desc"
    });

    res.json({
      ok: true,
      data: Array.isArray(data) ? data : []
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      message: "Gagal mengambil kas"
    });
  }
});

app.post("/api/cash", requireLogin, async (req, res) => {
  try {
    const data = await supabaseRequest("kas_rt", {
      method: "POST",
      body: req.body
    });

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      message: "Gagal menyimpan kas"
    });
  }
});

/* HEALTH CHECK */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "RT KITA berjalan"
  });
});

/* FILE WEBSITE */
app.use(express.static(__dirname));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

module.exports = app;
