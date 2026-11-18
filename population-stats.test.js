"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPopulationStats } = require("./population-stats");

test("menghitung warga aktif menurut status hunian dan NIK", () => {
  const stats = buildPopulationStats([
    { status_warga: "aktif", status_hunian: "Warga Tetap", nik: "123" },
    { status_warga: "aktif", status_hunian: "Warga Kontrak", nik: "456" },
    { status_warga: "aktif", status_hunian: null, nik: "" },
    { status_warga: "nonaktif", status_hunian: "Warga Tetap", nik: "789" }
  ]);
  assert.deepEqual(stats, {
    totalWarga: 3,
    wargaMenetap: 1,
    wargaKontrak: 1,
    statusHunianBelumDiisi: 1,
    belumAdaNik: 1,
    rumah: { total: null, status: "pendataan_diperlukan" }
  });
});

test("status hunian tidak dikenal masuk kelompok belum diisi", () => {
  const stats = buildPopulationStats([{ status_warga: "aktif", status_hunian: "Kos", nik: "1" }]);
  assert.equal(stats.statusHunianBelumDiisi, 1);
  assert.equal(stats.wargaKontrak, 0);
});
