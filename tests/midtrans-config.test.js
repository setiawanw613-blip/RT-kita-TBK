const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getMidtransApiBaseForNewTransaction,
  getMidtransApiBaseForOrder,
  getMidtransModeInfo
} = require("../midtrans-config");

const SANDBOX = "https://api.sandbox.midtrans.com";
const PRODUCTION = "https://api.midtrans.com";

test("new transactions default to sandbox and require explicit production mode", () => {
  assert.equal(getMidtransApiBaseForNewTransaction({}), SANDBOX);
  assert.equal(getMidtransApiBaseForNewTransaction({ MIDTRANS_IS_PRODUCTION: "false" }), SANDBOX);
  assert.equal(getMidtransApiBaseForNewTransaction({ MIDTRANS_IS_PRODUCTION: "true" }), PRODUCTION);
});

test("legacy and sandbox order IDs stay on sandbox", () => {
  const env = { MIDTRANS_IS_PRODUCTION: "true" };
  assert.equal(getMidtransApiBaseForOrder("RTTBK-1793118958100-legacy", env), SANDBOX);
  assert.equal(getMidtransApiBaseForOrder("RTTBK-SBX-123-abcd", env), SANDBOX);
});

test("production order IDs stay on production if current mode changes", () => {
  const env = { MIDTRANS_IS_PRODUCTION: "false" };
  assert.equal(getMidtransApiBaseForOrder("RTTBK-PROD-123-abcd", env), PRODUCTION);
});

test("mode metadata reveals only whether a key is configured", () => {
  assert.deepEqual(getMidtransModeInfo({ MIDTRANS_IS_PRODUCTION: "false" }), { mode: "sandbox", configured: false });
  assert.deepEqual(getMidtransModeInfo({ MIDTRANS_IS_PRODUCTION: "true", MIDTRANS_SERVER_KEY: "secret-value" }), { mode: "production", configured: true });
});
