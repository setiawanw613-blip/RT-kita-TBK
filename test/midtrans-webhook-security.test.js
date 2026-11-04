"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { isValidMidtransSignature, isSuccessfulMidtransStatus } = require("../midtrans-webhook-security");

const input = { orderId: "RT-TEST-001", statusCode: "200", grossAmount: "35000.00", serverKey: "sandbox-secret" };
const signatureKey = crypto.createHash("sha512").update(input.orderId + input.statusCode + input.grossAmount + input.serverKey).digest("hex");

test("menerima signature Midtrans yang cocok", () => {
  assert.equal(isValidMidtransSignature({ ...input, signatureKey }), true);
});
test("menolak signature palsu, rusak, atau secret berbeda", () => {
  assert.equal(isValidMidtransSignature({ ...input, signatureKey: "0".repeat(128) }), false);
  assert.equal(isValidMidtransSignature({ ...input, signatureKey: "abc" }), false);
  assert.equal(isValidMidtransSignature({ ...input, signatureKey, serverKey: "wrong" }), false);
});
test("hanya settlement atau capture accept yang dianggap berhasil", () => {
  assert.equal(isSuccessfulMidtransStatus("settlement", undefined), true);
  assert.equal(isSuccessfulMidtransStatus("capture", "accept"), true);
  assert.equal(isSuccessfulMidtransStatus("capture", "challenge"), false);
  assert.equal(isSuccessfulMidtransStatus("pending", undefined), false);
  assert.equal(isSuccessfulMidtransStatus("deny", undefined), false);
});
