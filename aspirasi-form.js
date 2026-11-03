/* FORM ASPIRASI WARGA & PENGELOLAAN RT — dimuat otomatis oleh server.js setelah index.html.
   Menggantikan fungsi aspirasi bawaan: menambah isian Kegunaan, Manfaat, dan penerima manfaat,
   memperbaiki tambah baris RAB, dan tombol cetak PDF A4. */
/* ASPIRASI WARGA */
function aspirasiWarga(){
  layout("Aspirasi Warga",`
    <div class="card">
      <p class="muted">Sampaikan kebutuhan lingkungan. Ukuran teknis boleh dikosongkan jika belum diketahui; pengurus RT dapat melakukan survei.</p>
      <label>Judul aspirasi</label><input id="aspJudul" placeholder="Contoh: Perbaikan saluran air">
      <label>Kategori</label>
      <select id="aspKategori">
        <option>Drainase / Got</option><option>Jalan lingkungan</option><option>Penerangan jalan</option><option>Kebersihan</option><option>Keamanan</option><option>Fasilitas umum</option><option>Lainnya</option>
      </select>
      <label>Tingkat urgensi</label>
      <select id="aspUrgensi"><option>Reguler</option><option>Prioritas</option><option>Urgent</option></select>
      <label>Lokasi lengkap</label><input id="aspLokasi" placeholder="Contoh: depan rumah nomor ... / gang ...">
      <label>Uraian kondisi / masalah</label><textarea id="aspUraian" placeholder="Jelaskan masalah dan dampaknya bagi warga"></textarea>
      <label>Kegunaan / tujuan usulan</label>
      <textarea id="aspKegunaan" placeholder="Contoh: agar air hujan mengalir lancar ke saluran utama dan tidak menggenangi jalan"></textarea>
      <label>Manfaat bagi warga <span class="muted" style="font-weight:400">(satu manfaat per baris)</span></label>
      <textarea id="aspManfaat" placeholder="Contoh:&#10;Tidak ada lagi genangan saat hujan&#10;Mengurangi sarang nyamuk&#10;Jalan tidak cepat rusak"></textarea>
      <label>Perkiraan warga yang merasakan manfaat <span class="muted" style="font-weight:400">(opsional)</span></label>
      <input id="aspPenerima" placeholder="Contoh: ± 24 KK di Blok C 8 dan C 9">
      <p class="muted" style="font-size:12px">Jika kegunaan/manfaat dikosongkan, proposal PDF akan memakai uraian standar sesuai kategori.</p>
      <h3>Ukuran kondisi saat ini (meter)</h3>
      <div class="grid"><div><label>Panjang</label><input id="aspKP" type="number" min="0" step=".01"></div><div><label>Lebar</label><input id="aspKL" type="number" min="0" step=".01"></div><div><label>Tinggi / kedalaman</label><input id="aspKT" type="number" min="0" step=".01"></div></div>
      <h3>Ukuran yang diusulkan (meter)</h3>
      <div class="grid"><div><label>Panjang</label><input id="aspUP" type="number" min="0" step=".01"></div><div><label>Lebar</label><input id="aspUL" type="number" min="0" step=".01"></div><div><label>Tinggi / kedalaman</label><input id="aspUT" type="number" min="0" step=".01"></div></div>
     <label>Solusi yang diharapkan</label>
<textarea id="aspSolusi" placeholder="Contoh: memperbesar saluran dan memperbaiki kemiringan aliran"></textarea>

<h3>Dokumentasi Lapangan</h3>
<p class="muted">Foto membantu pengurus RT dan pihak kelurahan memahami kondisi sebenarnya.</p>

<label>Foto kondisi awal</label>
<input id="aspFotoKondisi" type="file" accept="image/jpeg,image/png">
<small class="muted">Foto lokasi sebelum perbaikan, maksimal 2 MB.</small>

<label>Foto pengukuran lapangan</label>
<input id="aspFotoPengukuran" type="file" accept="image/jpeg,image/png">
<small class="muted">Foto saat mengukur panjang, lebar, atau kedalaman, maksimal 2 MB.</small>
      <button class="btn" style="width:100%;margin-top:14px" onclick="simpanAspirasi()">Kirim Aspirasi</button>
    </div>
    <div class="card"><h3>Riwayat Aspirasi Saya</h3><div id="aspRiwayat">Memuat...</div></div>
  `);
  muatAspirasiWarga();
}
async function simpanAspirasi(){
  const val=id=>document.getElementById(id)?.value?.trim()||"";

  try{
    const hasil=await api("/api/aspirasi",{
      method:"POST",
      body:JSON.stringify({
        judul:val("aspJudul"),
        kategori:val("aspKategori"),
        urgensi:val("aspUrgensi"),
        lokasi:val("aspLokasi"),
        uraian:val("aspUraian"),
        kondisi_panjang:val("aspKP"),
        kondisi_lebar:val("aspKL"),
        kondisi_tinggi:val("aspKT"),
        usulan_panjang:val("aspUP"),
        usulan_lebar:val("aspUL"),
        usulan_tinggi:val("aspUT"),
        solusi_usulan:val("aspSolusi"),
        kegunaan:val("aspKegunaan"),
        manfaat:val("aspManfaat"),
        penerima_manfaat:val("aspPenerima")
      })
    });

    const id=hasil?.data?.id || hasil?.id;
    if(!id) throw new Error("Aspirasi tersimpan, tetapi ID tidak ditemukan.");

    const fotoKondisi=document.getElementById("aspFotoKondisi")?.files?.[0];
    const fotoPengukuran=document.getElementById("aspFotoPengukuran")?.files?.[0];

    if(fotoKondisi || fotoPengukuran){
      const form=new FormData();
      if(fotoKondisi) form.append("foto_kondisi",fotoKondisi);
      if(fotoPengukuran) form.append("foto_pengukuran",fotoPengukuran);

      await api(`/api/aspirasi/${encodeURIComponent(id)}/dokumentasi`,{
        method:"POST",
        body:form
      });
    }

    alert("Aspirasi berhasil dikirim.");
    aspirasiWarga();
  }catch(e){
    alert(e.message);
  }
}
async function muatAspirasiWarga(){
  const box=document.getElementById("aspRiwayat"); if(!box)return;
  try{
    const rows=await api("/api/aspirasi");
    box.innerHTML=rows.length?rows.map(a=>`<div class="row"><b>${esc(a.judul)}</b><div>${esc(a.kategori)} · ${esc(a.urgensi)}</div><div>${esc(a.lokasi)}</div><span class="badge">${esc(a.status)}</span>${a.catatan?`<p class="muted">Catatan RT: ${esc(a.catatan)}</p>`:""}</div>`).join(""):"<p class='muted'>Belum ada aspirasi.</p>";
  }catch(e){box.innerHTML=`<div class="error">${esc(e.message)}</div>`;}
}
async function aspirasiAdmin(){
  layout("Pengelolaan Aspirasi",`<div class="card" id="aspAdminList">Memuat...</div>`);
  try{
    const rows=await api("/api/aspirasi"), box=document.getElementById("aspAdminList");
    if(!rows.length){box.innerHTML="<p class='muted'>Belum ada aspirasi warga.</p>";return;}
    box.innerHTML=rows.map(a=>`<div class="row">
      <b>${esc(a.judul)}</b><div>Pengusul: ${esc(a.nama_warga||"Warga")}</div>
      <div>${esc(a.kategori)} · <b>${esc(a.urgensi)}</b></div><div>Lokasi: ${esc(a.lokasi)}</div>
      <p>${esc(a.uraian)}</p>
      <div class="muted">Ukuran saat ini: ${esc(a.dimensi?.kondisi_panjang||"-")} × ${esc(a.dimensi?.kondisi_lebar||"-")} × ${esc(a.dimensi?.kondisi_tinggi||"-")} m</div>
      <div class="muted">Ukuran usulan: ${esc(a.dimensi?.usulan_panjang||"-")} × ${esc(a.dimensi?.usulan_lebar||"-")} × ${esc(a.dimensi?.usulan_tinggi||"-")} m</div>
      <span class="badge">${esc(a.status)}</span>
      <label>Status</label><select id="aspStatus_${esc(a.id)}">${["Diajukan","Verifikasi RT","Perlu revisi","Disetujui RT","Diteruskan ke kelurahan","Dalam pengerjaan","Selesai","Ditunda","Ditolak"].map(x=>`<option ${a.status===x?"selected":""}>${x}</option>`).join("")}</select>
      <label>Kegunaan / tujuan usulan</label><textarea id="aspKeg_${esc(a.id)}" placeholder="Kosongkan untuk memakai uraian standar kategori">${esc(a.dimensi?.kegunaan||"")}</textarea>
      <label>Manfaat bagi warga (satu per baris)</label><textarea id="aspMan_${esc(a.id)}" placeholder="Kosongkan untuk memakai uraian standar kategori">${esc(a.dimensi?.manfaat||"")}</textarea>
      <label>Perkiraan penerima manfaat</label><input id="aspPen_${esc(a.id)}" placeholder="Contoh: ± 24 KK" value="${esc(a.dimensi?.penerima_manfaat||"")}">
      <label>Catatan / hasil survei</label><textarea id="aspCat_${esc(a.id)}">${esc(a.catatan||"")}</textarea>
      <label>Rencana kerja <span class="muted" style="font-weight:400">(satu langkah per baris)</span></label><textarea id="aspRencana_${esc(a.id)}">${esc(a.rencana_kerja||"")}</textarea>
      <h4>RAB (isi angka hasil survei dan harga setempat)</h4>
      <div id="aspRab_${esc(a.id)}">${(Array.isArray(a.rab)?a.rab:[]).map((x,i)=>`<div class="row"><input data-rab="${i}" data-field="item" placeholder="Nama pekerjaan/material" value="${esc(x.item)}"><input data-rab="${i}" data-field="spesifikasi" placeholder="Spesifikasi" value="${esc(x.spesifikasi)}"><input data-rab="${i}" data-field="tujuan" placeholder="Kegunaan" value="${esc(x.tujuan)}"><div class="grid"><input data-rab="${i}" data-field="volume" type="number" step=".01" placeholder="Volume" value="${esc(x.volume)}"><input data-rab="${i}" data-field="satuan" placeholder="Satuan" value="${esc(x.satuan)}"><input data-rab="${i}" data-field="harga_satuan" type="number" placeholder="Harga satuan" value="${esc(x.harga_satuan)}"></div></div>`).join("")}</div>
      <button class="btn secondary" onclick="tambahBarisRab('${esc(a.id)}')">+ Tambah item RAB</button>
      <button class="btn" onclick="simpanAspirasiAdmin('${esc(a.id)}')" style="margin-top:8px">Simpan perubahan</button>
      <button class="btn secondary" onclick="window.open('/api/aspirasi/${encodeURIComponent(a.id)}/pdf','_blank')" style="margin-top:8px">🖨️ Lihat / Cetak Proposal PDF (A4)</button>
      <div class="muted" style="font-size:12px;margin-top:4px">Simpan perubahan dulu sebelum mencetak. Cetak di kertas HVS A4, skala 100% / "Ukuran sebenarnya".</div>
    </div>`).join("");
  }catch(e){document.getElementById("aspAdminList").innerHTML=`<div class="error">${esc(e.message)}</div>`;}
}
function tambahBarisRab(id){
  const box=document.getElementById("aspRab_"+id); if(!box)return;
  const n=box.querySelectorAll('[data-field="item"]').length;
  box.insertAdjacentHTML("beforeend",`<div class="row"><input data-rab="${n}" data-field="item" placeholder="Nama pekerjaan/material"><input data-rab="${n}" data-field="spesifikasi" placeholder="Spesifikasi"><input data-rab="${n}" data-field="tujuan" placeholder="Kegunaan"><div class="grid"><input data-rab="${n}" data-field="volume" type="number" step=".01" placeholder="Volume"><input data-rab="${n}" data-field="satuan" placeholder="Satuan"><input data-rab="${n}" data-field="harga_satuan" type="number" placeholder="Harga satuan"></div></div>`);
}
async function simpanAspirasiAdmin(id){
  const val=s=>document.getElementById(s)?.value||"";
  const box=document.getElementById("aspRab_"+id), grouped={};
  box?.querySelectorAll("[data-rab]").forEach(el=>{const i=el.dataset.rab;grouped[i]=grouped[i]||{};grouped[i][el.dataset.field]=el.value;});
  const rab=Object.values(grouped).filter(x=>x.item||x.spesifikasi||x.volume);
  try{
    await api("/api/aspirasi/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify({
      status:val("aspStatus_"+id),catatan:val("aspCat_"+id),rencana_kerja:val("aspRencana_"+id),rab,
      kegunaan:val("aspKeg_"+id),manfaat:val("aspMan_"+id),penerima_manfaat:val("aspPen_"+id)
    })});
    alert("Perubahan aspirasi tersimpan."); aspirasiAdmin();
  }catch(e){alert(e.message);}
}
