const test = require("node:test");
const assert = require("node:assert/strict");
const { cancelPendingMidtransTransaction } = require("../midtrans-cancel");

test("checks pending status before cancelling", async () => {
  const calls = [];
  const result = await cancelPendingMidtransTransaction({
    orderId: "RTTBK-SBX-123456-abcdef12",
    serverKey: "SB-test-key",
    apiBase: "https://api.sandbox.midtrans.com",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({
        transaction_status: calls.length === 1 ? "pending" : "cancel"
      }) };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(x => x.options.method), ["GET", "POST"]);
  assert.match(calls[0].url, /\/status$/);
  assert.match(calls[1].url, /\/cancel$/);
  assert.match(calls[0].options.headers.Authorization, /^Basic /);
});

test("never cancels a settled transaction", async () => {
  let calls = 0;
  const result = await cancelPendingMidtransTransaction({
    orderId: "RTTBK-PROD-123456-abcdef12",
    serverKey: "production-key",
    apiBase: "https://api.midtrans.com",
    fetchImpl: async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ transaction_status: "settlement" }) };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_pending");
  assert.equal(calls, 1);
});

test("rejects invalid order IDs and API hosts", async () => {
  for (const input of [
    { orderId: "unrelated-order", apiBase: "https://api.sandbox.midtrans.com" },
    { orderId: "RTTBK-SBX-123456-abcdef12", apiBase: "https://attacker.example" }
  ]) {
    await assert.rejects(cancelPendingMidtransTransaction({
      ...input, serverKey: "key", fetchImpl: async () => { throw new Error("must not run"); }
    }), TypeError);
  }
});
