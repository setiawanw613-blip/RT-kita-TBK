"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { canAccessOwnedRecord } = require("../access-control");

test("warga hanya dapat mengakses data miliknya", () => {
  assert.equal(canAccessOwnedRecord({ role: "warga", wargaId: 12 }, 12), true);
  assert.equal(canAccessOwnedRecord({ role: "warga", wargaId: 12 }, 13), false);
  assert.equal(canAccessOwnedRecord({ role: "warga", wargaId: "12" }, 12), true);
});
test("admin dapat mengakses data warga untuk tugas administrasi", () => {
  assert.equal(canAccessOwnedRecord({ role: "admin" }, 13), true);
});
test("menolak sesi hilang, role asing, dan identitas kosong", () => {
  assert.equal(canAccessOwnedRecord(null, 12), false);
  assert.equal(canAccessOwnedRecord({ role: "guest", wargaId: 12 }, 12), false);
  assert.equal(canAccessOwnedRecord({ role: "warga" }, 12), false);
  assert.equal(canAccessOwnedRecord({ role: "warga", wargaId: 12 }, null), false);
});
