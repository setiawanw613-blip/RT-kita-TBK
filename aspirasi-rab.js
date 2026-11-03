"use strict";
function kenaliKategoriAspirasi(kategori){
 const s=String(kategori||"").toLowerCase();
 if(s.includes("hotmix")||s.includes("aspal"))return "hotmix";
 if(s.includes("paving"))return "paving";
 if(s.includes("beton"))return "beton";
 if(s.includes("jalan"))return "hotmix";
 if(s.includes("drainase")||s.includes("got"))return "drainase";
 if(s.includes("penerangan")||s.includes("lampu"))return "lampu";
 if(s.includes("bersih")||s.includes("sampah"))return "kebersihan";
 if(s.includes("aman"))return "keamanan";
 if(s.includes("fasilitas"))return "fasilitas";
 return "lainnya";
}
const items={
 hotmix:[["Pembersihan dan persiapan badan jalan","Area kerja sesuai pengukuran","Menyiapkan area pekerjaan","area","m2"],["Perbaikan pondasi jalan","Jenis dan ketebalan ditentukan setelah survei","Menyiapkan dasar jalan","area","m2"],["Penghamparan aspal hotmix","Campuran dan ketebalan mengikuti spesifikasi survei","Lapisan permukaan jalan","area","m2"],["Pemadatan akhir","Metode sesuai spesifikasi","Memadatkan lapisan hotmix","area","m2"]],
 paving:[["Perataan badan jalan","Area kerja sesuai pengukuran","Menyiapkan dasar pemasangan","area","m2"],["Urugan lapisan dasar","Jenis dan ketebalan ditetapkan setelah survei","Pondasi paving","area","m2"],["Pengadaan paving block","Mutu dan ketebalan ditentukan saat survei","Permukaan jalan","area","m2"],["Pemasangan paving","Pola mengikuti kondisi lokasi","Memasang permukaan jalan","area","m2"]],
 beton:[["Persiapan tanah dasar","Metode sesuai kondisi tanah","Menyiapkan dasar jalan","area","m2"],["Lapis pondasi bawah","Material dan ketebalan setelah survei","Pondasi beton","area","m2"],["Pengecoran beton jalan","Mutu dan tebal wajib ditetapkan teknis","Lapisan perkerasan","beton","m3"]],
 drainase:[["Pembersihan saluran","Pembersihan endapan dan penghalang","Menyiapkan area","","m1"],["Galian tanah saluran","Dimensi ditetapkan setelah survei","Membentuk saluran","","m3"],["Lantai dasar saluran","Spesifikasi ditetapkan setelah survei","Dasar saluran","","m2"],["Dinding saluran","Konstruksi ditentukan setelah survei","Mengarahkan aliran","","m2"]],
 lampu:[["Lampu / armatur LED","Daya disesuaikan lokasi","Penerangan","","unit"],["Tiang dan dudukan","Tinggi dan material setelah survei","Penyangga lampu","","unit"],["Kabel dan instalasi","Panjang mengikuti jalur aktual","Penyaluran daya","","m1"]],
 kebersihan:[["Sarana kebersihan","Jenis dan jumlah setelah pendataan","Menampung sampah","","unit"],["Peralatan kebersihan","Sesuai jenis kegiatan","Mendukung kegiatan","","paket"],["Pengangkutan sampah","Volume sesuai kondisi aktual","Mengurangi penumpukan","","rit"]],
 keamanan:[["Sarana keamanan","Jenis dan jumlah setelah survei","Kebutuhan keamanan","","unit"],["Perlengkapan pemasangan","Menyesuaikan sarana terpilih","Mendukung pemasangan","","paket"]],
 fasilitas:[["Persiapan lokasi","Lingkup setelah survei","Menyiapkan area","","paket"],["Material utama fasilitas","Jenis dan volume setelah survei","Komponen pekerjaan","","paket"],["Jasa pemasangan / perbaikan","Sesuai lingkup","Melaksanakan pekerjaan","","paket"]],
 lainnya:[["Persiapan dan survei","Sesuai kebutuhan","Menentukan kebutuhan","","paket"],["Material utama","Ditentukan setelah survei","Memenuhi kebutuhan","","paket"],["Jasa pelaksanaan","Sesuai lingkup","Melaksanakan pekerjaan","","paket"]]
};
const titles={hotmix:"Perbaikan Jalan Lingkungan dengan Aspal Hotmix",paving:"Perbaikan Jalan Lingkungan dengan Paving Block",beton:"Perbaikan Jalan Lingkungan dengan Beton",drainase:"Perbaikan Saluran Drainase Lingkungan",lampu:"Pengadaan / Perbaikan Penerangan Jalan Lingkungan",kebersihan:"Program Perbaikan Kebersihan Lingkungan",keamanan:"Peningkatan Sarana Keamanan Lingkungan",fasilitas:"Peningkatan / Perbaikan Fasilitas Umum",lainnya:"Usulan Kebutuhan Lingkungan"};
function buatTemplateRab(kategori,d={}){
 const k=kenaliKategoriAspirasi(kategori),p=Number(d.usulan_panjang||d.kondisi_panjang||0),l=Number(d.usulan_lebar||d.kondisi_lebar||0),t=Number(d.usulan_tinggi||d.kondisi_tinggi||0);
 const area=p>0&&l>0?Number((p*l).toFixed(2)):"",vol=area!==""&&t>0?Number((area*t).toFixed(3)):"";
 return items[k].map(([item,spesifikasi,tujuan,rumus,satuan])=>({item,spesifikasi,tujuan,volume:rumus==="area"?area:rumus==="beton"?vol:"",satuan,harga_satuan:"",total:""}));
}
function buatRencanaKerja(k){const key=kenaliKategoriAspirasi(k);const teks={hotmix:"Survei badan jalan.\\nPembersihan dan persiapan permukaan.\\nPemeriksaan pondasi dan ketebalan aspal.\\nPenyusunan volume dan harga berdasarkan survei.\\nPelaksanaan setelah persetujuan.\\nPemeriksaan mutu dan dokumentasi.",paving:"Survei dan pengukuran jalan.\\nPersiapan badan jalan.\\nPemeriksaan lapisan dasar dan paving.\\nPenyusunan RAB berdasarkan survei.\\nPemasangan dan pemadatan paving.\\nPemeriksaan hasil.",beton:"Survei kondisi jalan.\\nPemeriksaan tanah dasar dan ketebalan beton.\\nPenetapan mutu melalui pemeriksaan teknis.\\nPenyusunan volume dan harga.\\nPengecoran setelah persetujuan.\\nPerawatan dan pemeriksaan hasil.",drainase:"Survei aliran dan kondisi saluran.\\nPengukuran dimensi saluran.\\nPenetapan bentuk dan material teknis.\\nPenyusunan volume dan harga.\\nPelaksanaan setelah persetujuan.\\nPemeriksaan aliran dan dokumentasi."};return (teks[key]||"Survei kebutuhan.\\nPenetapan lingkup pekerjaan.\\nPenyusunan RAB berdasarkan survei dan harga setempat.\\nPelaksanaan setelah persetujuan.\\nPemeriksaan dan dokumentasi.").split("\\n").map((x,i)=>(i+1)+". "+x).join("\\n");}
function infoKategoriAspirasi(k){const key=kenaliKategoriAspirasi(k);return{key,label:titles[key],judul:titles[key]};}
const api={kenaliKategoriAspirasi,buatTemplateRab,buatRencanaKerja,infoKategoriAspirasi};
if(typeof module!=="undefined"&&module.exports)module.exports=api;
if(typeof window!=="undefined")window.AspirasiRab=api;
