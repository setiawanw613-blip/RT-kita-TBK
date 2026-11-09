const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  getGoBizConfig,
  isGoBizConfigured,
  verifyGoBizWebhookSignature,
  isGoBizExpiredStatus,
  isGoBizSettlementStatus,
  normalizeGoBizTransactionStatus
} = require("./gobiz-payment");

test("GoBiz production and sandbox endpoints are selected from configuration", () => {
  const production = getGoBizConfig({
    GOBIZ_ENVIRONMENT: "production",
    GOBIZ_CLIENT_ID: "client",
    GOBIZ_CLIENT_SECRET: "secret",
    GOBIZ_OUTLET_ID: "G123"
  });
  assert.equal(production.apiBase, "https://api.gobiz.co.id");
  assert.equal(production.oauthBase, "https://accounts.go-jek.com");
  const sandbox = getGoBizConfig({ GOBIZ_ENVIRONMENT: "sandbox" });
  assert.equal(sandbox.apiBase, "https://api.partner-sandbox.gobiz.co.id");
  assert.equal(sandbox.oauthBase, "https://integration-goauth.gojekapi.com");
});

test("GoBiz integration is not considered configured without all required credentials", () => {
  assert.equal(isGoBizConfigured({ GOBIZ_CLIENT_ID: "id", GOBIZ_CLIENT_SECRET: "secret" }), false);
  assert.equal(isGoBizConfigured({
    GOBIZ_CLIENT_ID: "id",
    GOBIZ_CLIENT_SECRET: "secret",
    GOBIZ_OUTLET_ID: "G123",
    GOBIZ_NOTIFICATION_SECRET_KEY: "webhook-secret"
  }), true);
});

test("GoBiz webhook HMAC accepts valid raw-body signature and rejects tampering", () => {
  const rawBody = JSON.stringify({
    header: { event_name: "payment.transaction.settlement" },
    body: { transaction: { order_id: "RTTBK-PROD-123-abcdef12" } }
  });
  const secret = "test-webhook-secret";
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  assert.equal(verifyGoBizWebhookSignature(rawBody, signature, secret), true);
  assert.equal(verifyGoBizWebhookSignature(rawBody + " ", signature, secret), false);
  assert.equal(verifyGoBizWebhookSignature(rawBody, "bad", secret), false);
  assert.equal(verifyGoBizWebhookSignature(rawBody, signature, ""), false);
});


test("GoBiz QRIS creation registers settlement webhook and sends idempotency key", async () => {
  const { createGoBizQrisTransaction } = require("./gobiz-payment");
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith("/oauth2/token")) {
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: "test-access-token", expires_in: 3600 })
      };
    }
    if (String(url).endsWith("/integrations/partner/v1/notification-subscriptions") && options.method !== "POST") {
      return { ok: true, status: 200, json: async () => ({ data: { subscriptions: [] } }) };
    }
    if (String(url).endsWith("/integrations/partner/v1/notification-subscriptions") && options.method === "POST") {
      return { ok: true, status: 201, json: async () => ({ success: true, data: { subscription: { active: true } } }) };
    }
    if (String(url).includes("/integrations/payment/outlets/G123/v2/transactions")) {
      return {
        ok: true, status: 201,
        json: async () => ({
          success: true,
          data: {
            transaction: {
              id: "00000000-0000-4000-8000-000000000001",
              order_id: "RTTBK-PROD-1900000000000-deadbeef",
              payment_type: "qris",
              status: "pending",
              gross_amount: 35000,
              qris_string: "000201010212..."
            },
            actions: []
          }
        })
      };
    }
    throw new Error("Unexpected GoBiz request: " + url);
  };

  const result = await createGoBizQrisTransaction({
    orderId: "RTTBK-PROD-1900000000000-deadbeef",
    total: 35000,
    namaWarga: "Warga Test",
    env: {
      GOBIZ_ENVIRONMENT: "production",
      GOBIZ_CLIENT_ID: "test-client",
      GOBIZ_CLIENT_SECRET: "test-secret",
      GOBIZ_OUTLET_ID: "G123",
      GOBIZ_NOTIFICATION_SECRET_KEY: "test-webhook-secret",
      GOBIZ_WEBHOOK_URL: "https://rt-kita-tbk.vercel.app/api/gobiz/webhook"
    },
    fetchImpl: fakeFetch
  });

  assert.equal(result.transaction.status, "pending");
  assert.equal(result.qr_string, "000201010212...");
  const createCall = calls.find(call => String(call.url).includes("/integrations/payment/outlets/G123/v2/transactions"));
  assert.ok(createCall);
  assert.equal(createCall.options.headers["Idempotency-Key"].length, 32);
  assert.ok(calls.some(call => String(call.url).endsWith("/integrations/partner/v1/notification-subscriptions") && call.options.method === "POST"));
});


test("GoBiz transaction detail lookup validates transaction identity and QRIS data", async () => {
  const { getGoBizTransactionDetail } = require("./gobiz-payment");
  const calls = [];
  const id = "71839e9c-944b-40ce-bd31-8a76db666f36";
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith("/oauth2/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "test-access-token", expires_in: 3600 }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          outlet: { id: "G123" },
          transaction: {
            id,
            order_id: "RTTBK-SBX-1900000000000-deadbeef",
            payment_type: "qris",
            status: "expire",
            gross_amount: 35000,
            currency: "IDR"
          }
        }
      })
    };
  };
  const result = await getGoBizTransactionDetail(id, {
    fetchImpl: fakeFetch,
    env: {
      GOBIZ_ENVIRONMENT: "sandbox",
      GOBIZ_CLIENT_ID: "test-client",
      GOBIZ_CLIENT_SECRET: "test-secret",
      GOBIZ_OUTLET_ID: "G123"
    }
  });
  assert.equal(result.transaction.status, "expire");
  assert.equal(result.transaction.order_id, "RTTBK-SBX-1900000000000-deadbeef");
  assert.ok(calls.some(call => String(call.url).includes("/integrations/payment/outlets/G123/v1/transactions/" + id)));
  await assert.rejects(
    () => getGoBizTransactionDetail("not-a-uuid", { env: { GOBIZ_OUTLET_ID: "G123" } }),
    /ID transaksi GoBiz tidak valid/
  );
});


test("GoBiz terminal transaction statuses are normalized safely", () => {
  for (const status of ["expire", "expired", "cancel", "cancelled", "deny", "denied"]) {
    assert.equal(isGoBizExpiredStatus(status), true);
  }
  assert.equal(isGoBizExpiredStatus("pending"), false);
  assert.equal(isGoBizSettlementStatus("SETTLEMENT"), true);
  assert.equal(isGoBizSettlementStatus("pending"), false);
  assert.equal(normalizeGoBizTransactionStatus(" Expire "), "expire");
});
