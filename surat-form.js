/* FORM AJUKAN SURAT — dimuat otomatis oleh server.js setelah script utama index.html.
   Fungsi di sini menggantikan newLetter() & saveLetter() bawaan agar isian
   menyesuaikan jenis surat. */
/* ===== AJUKAN SURAT — form menyesuaikan jenis surat ===== */
const JENIS_SURAT_INFO = {
  "Surat Pengantar": {
    info: "Pengantar umum dari RT untuk mengurus administrasi di Desa/instansi (KTP-el, KK, akta, pindah datang, nikah, BPJS, dll).",
    contoh: "Contoh: Pengurusan perpanjangan Kartu Keluarga (KK) di Desa Sukahurip",
    rincian: []
  },
  "Surat Keterangan Domisili": {
    info: "Menerangkan bahwa Anda benar bertempat tinggal di wilayah RT 004 / RW 001 Perum. Taman Bali Kahuripan.",
    contoh: "Contoh: Persyaratan pembukaan rekening bank / melamar pekerjaan",
    rincian: [
      { label: "Tinggal Sejak", placeholder: "Contoh: tahun 2018", wajib: false }
    ]
  },
  "Surat Keterangan Tidak Mampu": {
    info: "Pengantar RT untuk pengurusan SKTM di Desa Sukahurip (keringanan biaya sekolah, berobat, BPJS PBI, bantuan sosial).",
    contoh: "Contoh: Pengajuan keringanan biaya pendidikan anak di SMPN 1 Sukatani",
    rincian: [
      { label: "Penghasilan per Bulan", placeholder: "Contoh: Rp1.500.000", wajib: true },
      { label: "Jumlah Tanggungan", placeholder: "Contoh: 4 orang", wajib: true }
    ]
  },
  "Surat Keterangan Usaha": {
    info: "Menerangkan bahwa Anda memiliki/menjalankan usaha di lingkungan RT (untuk KUR, pinjaman modal, izin usaha, dll).",
    contoh: "Contoh: Persyaratan pengajuan KUR di Bank BRI",
    rincian: [
      { label: "Nama Usaha", placeholder: "Contoh: Warung Sembako Berkah", wajib: true },
      { label: "Bidang Usaha", placeholder: "Contoh: Perdagangan sembako / kuliner / jasa", wajib: true },
      { label: "Alamat Usaha", placeholder: "Contoh: Blok C 8 No. 30, Perum. Taman Bali Kahuripan", wajib: true },
      { label: "Usaha Sejak", placeholder: "Contoh: tahun 2019", wajib: false }
    ]
  },
  "Surat Pengantar SKCK": {
    info: "Pengantar dari RT sebagai syarat membuat SKCK di Polsek/Polres.",
    contoh: "Contoh: Persyaratan melamar pekerjaan di PT ...",
    rincian: []
  }
};

function idRincianSurat(label){
  return "rincian_" + label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function newLetter(){
  layout("Ajukan Surat",`
    <div class="card">
      <label>Jenis surat</label>
      <select id="letterType" onchange="renderLetterFields()">
        <option value="">-- Pilih jenis surat --</option>
        ${Object.keys(JENIS_SURAT_INFO).map(j =>
          `<option value="${esc(j)}">${esc(j)}</option>`
        ).join("")}
      </select>

      <div id="letterInfo" class="muted" style="font-size:13px;margin-top:8px"></div>

      <div id="letterExtra"></div>

      <label>Keperluan</label>
      <textarea id="letterPurpose" maxlength="300"
        placeholder="Tuliskan keperluan surat"></textarea>
      <div class="muted" style="font-size:12px;margin-top:4px">
        Data diri (nama, NIK, alamat, dll.) otomatis diambil dari menu Data Saya.
      </div>

      <button class="btn" style="margin-top:16px" onclick="saveLetter()">
        Ajukan surat
      </button>

      <button class="btn secondary" style="margin-top:8px" onclick="wargaHome()">
        Kembali
      </button>
    </div>
  `);
}

function renderLetterFields(){
  const jenis = document.getElementById("letterType").value;
  const cfg = JENIS_SURAT_INFO[jenis];
  const info = document.getElementById("letterInfo");
  const extra = document.getElementById("letterExtra");
  const purpose = document.getElementById("letterPurpose");

  if (!cfg) {
    info.innerHTML = "";
    extra.innerHTML = "";
    purpose.placeholder = "Tuliskan keperluan surat";
    return;
  }

  info.innerHTML = "ℹ️ " + esc(cfg.info);
  purpose.placeholder = cfg.contoh;
  extra.innerHTML = cfg.rincian.map(r => `
    <label>${esc(r.label)}${r.wajib ? "" : " <span class='muted' style='font-weight:400'>(opsional)</span>"}</label>
    <input id="${idRincianSurat(r.label)}" maxlength="120"
      placeholder="${esc(r.placeholder)}">
  `).join("");
}

async function saveLetter(){
  const jenis = document.getElementById("letterType").value;
  const cfg = JENIS_SURAT_INFO[jenis];
  const keperluan = document.getElementById("letterPurpose").value
    .replace(/\s+/g, " ").trim();

  if (!cfg) {
    alert("Pilih jenis surat terlebih dahulu.");
    return;
  }

  if (!keperluan) {
    alert("Keperluan surat wajib diisi.");
    return;
  }

  const baris = [keperluan];

  for (const r of cfg.rincian) {
    const nilai = (document.getElementById(idRincianSurat(r.label))?.value || "")
      .replace(/\s+/g, " ").trim();

    if (r.wajib && !nilai) {
      alert(r.label + " wajib diisi.");
      return;
    }
    if (nilai) baris.push(r.label + ": " + nilai);
  }

  try{
    await api("/api/letters",{
      method:"POST",
      body:JSON.stringify({
        type: jenis,
        purpose: baris.join("\n")
      })
    });

    alert("Pengajuan surat berhasil dikirim");
    myLetters();
  }catch(e){
    alert(e.message);
  }
}

/* Perbaikan tampilan HP (header, menu bawah, kartu saldo) */
(function(){var s=document.createElement("script");s.src="/tampilan-hp.js?v=1";document.head.appendChild(s);})();
