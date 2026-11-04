const test = require("node:test");
const assert = require("node:assert/strict");
const { cancelPendingMidtransTransaction } = require("../midtrans-cancel");

test("cancels a pending RT Kita Midtrans order", async () => {
  let requested;
  const result = await cancelPendingMidtransTransaction({
    orderId: "RTTBK-SBX-123456-abcdef12",
    serverKey: "SB-test-key",
    apiBase: "https://api.sandbox.midtrans.com",
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ transaction_status: "cancel" })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "cancel");
  assert.equal(requested.options.method, "POST");
  assert.match(requested.url, /\/cancel$/);
  assert.match(requested.options.headers.Authorization, /^Basic /);
});

test("does not report success when Midtrans does not cancel", async () => {
  const result = await cancelPendingMidtransTransaction({
    orderId: "RTTBK-PROD-123456-abcdef12",
    serverKey: "production-key",
    apiBase: "https://api.midtrans.com",
    fetchImpl: async () => ({
      ok: false,
      status: 412,
      json: async () => ({ transaction_status: "settlement" })
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "settlement");
});

test("rejects invalid order IDs and API hosts", async () => {
  await assert.rejects(
    cancelPendingMidtransTransaction({
      orderId: "unrelated-order",
      serverKey: "key",
      apiBase: "https://api.sandbox.midtrans.com",
      fetchImpl: async () => { throw new Error("must not run"); }
    }),
    TypeError
  );
  await assert.rejects(
    cancelPendingMidtransTransaction({
      orderId: "RTTBK-SBX-123456-abcdef12",
      serverKey: "key",
      apiBase: "https://attacker.example",
      fetchImpl: async () => { throw new Error("must not run"); }
    }),
    TypeError
  );
});
