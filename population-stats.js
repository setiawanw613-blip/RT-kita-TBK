"use strict";

function buildPopulationStats(rows) {
  const residents = Array.isArray(rows) ? rows : [];
  const active = residents.filter(row => String(row?.status_warga || "").trim().toLowerCase() === "aktif");
  let menetap = 0;
  let kontrak = 0;
  let statusHunianBelumDiisi = 0;
  let tanpaNik = 0;

  for (const row of active) {
    const status = String(row?.status_hunian || "").trim().toLowerCase();
    if (status === "warga tetap" || status === "menetap" || status === "tetap") menetap++;
    else if (status === "warga kontrak" || status === "kontrak" || status === "mengontrak") kontrak++;
    else statusHunianBelumDiisi++;

    if (!String(row?.nik || "").trim()) tanpaNik++;
  }

  return {
    totalWarga: active.length,
    wargaMenetap: menetap,
    wargaKontrak: kontrak,
    statusHunianBelumDiisi,
    belumAdaNik: tanpaNik,
    // Jumlah rumah sengaja tidak ditebak dari jumlah KK/alamat.
    rumah: { total: null, status: "pendataan_diperlukan" }
  };
}

module.exports = { buildPopulationStats };
