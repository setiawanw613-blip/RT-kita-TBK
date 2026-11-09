"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { isValidMidtransSignature, isSuccessfulMidtransStatus } = require("./midtrans-webhook-security");

function makeSignature(orderId, statusCode, grossAmount, serverKey) {
  return crypto.createHash("sha512").update(orderId + statusCode + grossAmount + serverKey).digest("hex");
}

test("menerima signature SHA-512 yang benar", () => {
  const values = { orderId: "RTTBK-SBX-123-a1b2c3d4", statusCode: "200", grossAmount: "35000.00", serverKey: "sandbox-secret" };
  assert.equal(isValidMidtransSignature({ ...values, signatureKey: makeSignature(values.orderId, values.statusCode, values.grossAmount, values.serverKey) }), true);
});

test("menolak signature salah dan format tidak valid", () => {
  assert.equal(isValidMidtransSignature({ orderId: "order", statusCode: "200", grossAmount: "35000", signatureKey: "0".repeat(128), serverKey: "secret" }), false);
  assert.equal(isValidMidtransSignature({ orderId: "order", statusCode: "200", grossAmount: "35000", signatureKey: "bad", serverKey: "secret" }), false);
});

test("hanya settlement atau capture accept dianggap berhasil", () => {
  assert.equal(isSuccessfulMidtransStatus("settlement", undefined), true);
  assert.equal(isSuccessfulMidtransStatus("capture", "accept"), true);
  assert.equal(isSuccessfulMidtransStatus("capture", "challenge"), false);
  assert.equal(isSuccessfulMidtransStatus("pending", undefined), false);
});