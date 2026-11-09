"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getMidtransApiBaseForNewTransaction, getMidtransApiBaseForOrder, getMidtransServerKeyForNewTransaction, getMidtransServerKeyForOrder, getMidtransModeInfo } = require("./midtrans-config");

test("produksi tidak pernah memakai server key sandbox", () => {
  const env = { MIDTRANS_IS_PRODUCTION: "true", MIDTRANS_SANDBOX_SERVER_KEY: "sandbox-secret" };
  assert.equal(getMidtransServerKeyForNewTransaction(env), "");
  assert.equal(getMidtransModeInfo(env).configured, false);
  assert.equal(getMidtransApiBaseForNewTransaction(env), "https://api.midtrans.com");
});

test("sandbox memakai key sandbox atau key legacy", () => {
  assert.equal(getMidtransServerKeyForNewTransaction({ MIDTRANS_SANDBOX_SERVER_KEY: "sandbox-key" }), "sandbox-key");
  assert.equal(getMidtransServerKeyForNewTransaction({ MIDTRANS_SERVER_KEY: "legacy-key" }), "legacy-key");
  assert.equal(getMidtransApiBaseForNewTransaction({}), "https://api.sandbox.midtrans.com");
});

test("webhook memilih key berdasarkan prefix order", () => {
  const env = { MIDTRANS_IS_PRODUCTION: "true", MIDTRANS_PRODUCTION_SERVER_KEY: "prod-key", MIDTRANS_SANDBOX_SERVER_KEY: "sandbox-key" };
  assert.equal(getMidtransServerKeyForOrder("RTTBK-PROD-1-abcd1234", env), "prod-key");
  assert.equal(getMidtransServerKeyForOrder("RTTBK-SBX-1-abcd1234", env), "sandbox-key");
  assert.equal(getMidtransApiBaseForOrder("RTTBK-SBX-1-abcd1234"), "https://api.sandbox.midtrans.com");
});