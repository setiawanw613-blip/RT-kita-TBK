"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { findConflictingSettledRows } = require("../midtrans-order-reconciliation");

test("mengizinkan webhook berulang dari transaksi yang sama", () => {
  const rows = [{
    id: 1, status: "lunas", bukti_transfer: "MIDTRANS:order-a",
    midtrans_transaction_id: "txn-a"
  }];
  assert.deepEqual(findConflictingSettledRows(rows, "order-a", "txn-a"), []);
});

test("mendeteksi transaksi berbeda meski marker masih menunjuk order baru", () => {
  const rows = [{
    id: 1, status: "lunas", bukti_transfer: "MIDTRANS:order-b",
    midtrans_transaction_id: "txn-a"
  }];
  assert.deepEqual(findConflictingSettledRows(rows, "order-b", "txn-b"), [rows[0]]);
});

test("mendeteksi order berbeda jika ID transaksi lama belum tersedia", () => {
  const rows = [{ id: 1, status: "lunas", bukti_transfer: "MIDTRANS:order-a" }];
  assert.deepEqual(findConflictingSettledRows(rows, "order-b", "txn-b"), [rows[0]]);
});

test("tidak menganggap baris yang belum lunas sebagai pembayaran ganda", () => {
  const rows = [{ id: 1, status: "menunggu_verifikasi", bukti_transfer: "MIDTRANS:order-a" }];
  assert.deepEqual(findConflictingSettledRows(rows, "order-b", "txn-b"), []);
});
