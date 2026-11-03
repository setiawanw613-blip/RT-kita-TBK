"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const api=require("../aspirasi-rab");
test("kategori aspirasi mengenali jalan hotmix, paving, beton, dan layanan lain",()=>{
 assert.equal(api.kenaliKategoriAspirasi("Perbaikan Jalan (Hotmix)"),"hotmix");
 assert.equal(api.kenaliKategoriAspirasi("Paving Block"),"paving");
 assert.equal(api.kenaliKategoriAspirasi("Jalan Beton"),"beton");
 assert.equal(api.kenaliKategoriAspirasi("Penerangan Jalan"),"lampu");
 assert.equal(api.kenaliKategoriAspirasi("Pilihan khusus"),"lainnya");
});
test("RAB hotmix mengikuti ukuran area tanpa mengarang harga",()=>{
 const rows=api.buatTemplateRab("Hotmix",{usulan_panjang:20,usulan_lebar:3});
 assert.equal(rows[0].volume,60);
 assert.equal(rows[0].harga_satuan,"");
 assert.ok(rows.some(row=>row.item.toLowerCase().includes("hotmix")));
});
test("volume beton tidak dihitung tanpa ketebalan yang diisi",()=>{
 const a=api.buatTemplateRab("Jalan Beton",{usulan_panjang:10,usulan_lebar:2});
 const b=api.buatTemplateRab("Jalan Beton",{usulan_panjang:10,usulan_lebar:2,usulan_tinggi:.15});
 assert.equal(a.find(row=>row.satuan==="m3").volume,"");
 assert.equal(b.find(row=>row.satuan==="m3").volume,3);
});
test("rencana kerja dan label kategori tersedia",()=>{
 assert.match(api.buatRencanaKerja("Drainase / Got"),/saluran/i);
 assert.equal(api.infoKategoriAspirasi("Hotmix").label,"Perbaikan Jalan Lingkungan dengan Aspal Hotmix");
});

test("normalisasi RAB mempertahankan volume dan harga yang belum diisi",()=>{
 const rows=api.normalisasiRabAspirasi([{item:"Penghamparan hotmix",volume:"",satuan:"m2",harga_satuan:""}]);
 assert.equal(rows[0].volume,null);
 assert.equal(rows[0].harga_satuan,null);
 assert.equal(rows[0].total,null);
});
test("normalisasi RAB menghitung subtotal hanya jika volume dan harga lengkap",()=>{
 const rows=api.normalisasiRabAspirasi([{item:"Hotmix",volume:"60",satuan:"m2",harga_satuan:"125000"}]);
 assert.equal(rows[0].total,7500000);
});
test("normalisasi RAB menolak angka negatif dan format tidak valid",()=>{
 assert.throws(()=>api.normalisasiRabAspirasi([{item:"Material",volume:"-1",harga_satuan:"100"}]),/angka nol atau lebih/);
 assert.throws(()=>api.normalisasiRabAspirasi("bukan daftar"),/Format RAB/);
});
