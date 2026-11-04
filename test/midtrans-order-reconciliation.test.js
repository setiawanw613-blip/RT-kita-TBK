"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { findConflictingSettledRows } = require("../midtrans-order-reconciliation");

test("mengizinkan webhook berulang dari order yang sama", () => {
  const rows = [{ id: 1, status: "lunas", bukti_transfer: "MIDTRANS:order-a" }];
  assert.deepEqual(findConflictingSettledRows(rows, "order-a"), []);
});

test("menandai baris lunas dari order berbeda sebagai potensi pembayaran ganda", () => {
  const rows = [
    { id: 1, status: "lunas", bukti_transfer: "MIDTRANS:order-a" },
    { id: 2, status: "menunggu_verifikasi", bukti_transfer: "MIDTRANS:order-b" }
  ];
  assert.deepEqual(findConflictingSettledRows(rows, "order-b"), [rows[0]]);
});

test("tidak menganggap baris yang belum lunas sebagai pembayaran ganda", () => {
  const rows = [{ id: 1, status: "menunggu_verifikasi", bukti_transfer: "MIDTRANS:order-a" }];
  assert.deepEqual(findConflictingSettledRows(rows, "order-b"), []);
});
