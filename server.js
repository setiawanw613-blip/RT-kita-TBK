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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum diatur.");
}

function supabase(pathname, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

const SECRET = process.env.SESSION_SECRET || "rt-kita-rahasia";

function makeToken(user) {
  const data = Buffer.from(JSON.stringify(user)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(data)
    .digest("base64url");

  return `${data}.${sig}`;
}

function readToken(req) {
  const cookie = req.headers.cookie || "";
  const found = cookie
    .split(";")
    .map(x => x.trim())
    .find(x => x.startsWith("rt_token="));

  if (!found) return null;

  const token = decodeURIComponent(found.substring("rt_token=".length));
  const parts = token.split(".");

  if (parts.length !== 2) return null;

  const [data, sig] = parts;

  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(data)
    .digest("base64url");

  if (sig !== expected) return null;

  try {
    return JSON.parse(Buffer.from(data, "base64url").toString());
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const user = readToken(req);

  if (!user) {
    return res.status(401).json({ error: "Belum login" });
  }

  req.user = user;
  next();
}

function admin(req, res, next) {
  const user = readToken(req);

  if (!user || user.role !== "admin") {
    return res.status(403).json({ error: "Khusus Ketua RT" });
  }

  req.user = user;
  next();
}

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  if (
    username !== ADMIN_USER ||
    password !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: "Username atau password salah"
    });
  }

  const user = {
    username: ADMIN_USER,
    role: "admin"
  };

  const token = makeToken(user);

  res.setHeader(
    "Set-Cookie",
    `rt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=28800`
  );

  res.json({ user });
});

app.post("/api/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    "rt_token=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0"
  );

  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json({ user: readToken(req) });
});

app.get("/api/dashboard", auth, async (req, res) => {
  try {
    const wargaResponse = await supabase(
      "warga?select=id&status_warga=eq.Aktif"
    );

    const warga = wargaResponse.ok
      ? await wargaResponse.json()
      : [];

    const suratResponse = await supabase(
      "pengajuan_surat?select=id&status=eq.Diajukan"
    );

    const surat = suratResponse.ok
      ? await suratResponse.json()
      : [];

    const kasResponse = await supabase(
      "kas_rt?select=*"
    );

    const kas = kasResponse.ok
      ? await kasResponse.json()
      : [];

    let balance = 0;

    for (const item of kas) {
      const jumlah = Number(
        item.jumlah ||
        item.amount ||
        item.nominal ||
        0
      );

      const jenis = String(
        item.jenis ||
        item.type ||
        item.tipe ||
        ""
      ).toLowerCase();

      if (
        jenis.includes("masuk") ||
        jenis.includes("pemasukan")
      ) {
        balance += jumlah;
      } else {
        balance -= jumlah;
      }
    }

    res.json({
      residents: warga.length,
      letters: surat.length,
      complaints: 0,
      balance
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Gagal mengambil dashboard"
    });
  }
});

app.get("/api/residents", admin, async (req, res) => {
  try {
    const response = await supabase(
      "warga?select=*&order=nama_lengkap.asc"
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: "Gagal mengambil data warga",
        detail: data
      });
    }

    const result = data.map(w => ({
      id: w.id,
      nik: w.nik,
      no_kk: w.no_kk,
      nama: w.nama_lengkap,
      alamat: w.alamat,
      no_hp: w.no_hp,
      status: w.status_warga
    }));

    res.json(result);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Gagal mengambil data warga"
    });
  }
});

app.post("/api/residents", admin, async (req, res) => {
  try {
    const {
      nik,
      no_kk,
      nama,
      alamat,
      no_hp,
      status = "Aktif"
    } = req.body;

    if (!nama) {
      return res.status(400).json({
        error: "Nama wajib diisi"
      });
    }

    const response = await supabase("warga", {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        nik: nik || null,
        no_kk: no_kk || null,
        nama_lengkap: nama,
        alamat: alamat || "",
        no_hp: no_hp || "",
        status_warga: status
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({
        error: "Gagal menambah warga",
        detail: data
      });
    }

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Gagal menambah warga"
    });
  }
});

app.put("/api/residents/:id", admin, async (req, res) => {
  try {
    const {
      nik,
      no_kk,
      nama,
      alamat,
      no_hp,
      status
    } = req.body;

    const response = await supabase(
      `warga?id=eq.${encodeURIComponent(req.params.id)}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          nik,
          no_kk,
          nama_lengkap: nama,
          alamat,
          no_hp,
          status_warga: status
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({
        error: "Gagal memperbarui warga",
        detail: data
      });
    }

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Gagal memperbarui warga"
    });
  }
});

app.get("/api/announcements", auth, async (req, res) => {
  try {
    const response = await supabase(
      "pengumuman?select=*&order=id.desc"
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: "Gagal mengambil pengumuman",
        detail: data
      });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: "Gagal mengambil pengumuman"
    });
  }
});

app.post("/api/announcements", admin, async (req, res) => {
  try {
    const { title, content } = req.body;

    const response = await supabase("pengumuman", {
      method: "POST",
      body: JSON.stringify({
        title,
        content
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({
        error: "Gagal membuat pengumuman",
        detail: data
      });
    }

    res.json({ ok: true, data });
  } catch (error) {
    res.status(500).json({
      error: "Gagal membuat pengumuman"
    });
  }
});

app.get("/api/letters", auth, async (req, res) => {
  try {
    const response = await supabase(
      "pengajuan_surat?select=*&order=id.desc"
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: "Gagal mengambil pengajuan surat",
        detail: data
      });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: "Gagal mengambil surat"
    });
  }
});

app.get("/api/cash", auth, async (req, res) => {
  try {
    const response = await supabase(
      "kas_rt?select=*&order=id.desc"
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: "Gagal mengambil kas RT",
        detail: data
      });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: "Gagal mengambil kas RT"
    });
  }
});

app.post("/api/cash", admin, async (req, res) => {
  try {
    const {
      type,
      description,
      amount
    } = req.body;

    const response = await supabase("kas_rt", {
      method: "POST",
      body: JSON.stringify({
        jenis: type,
        keterangan: description,
        jumlah: Number(amount)
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({
        error: "Gagal menyimpan kas",
        detail: data
      });
    }

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    res.status(500).json({
      error: "Gagal menyimpan kas"
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "RT Kita"
  });
});

app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

module.exports = app;
