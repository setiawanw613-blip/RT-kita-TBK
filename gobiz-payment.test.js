const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  getGoBizConfig,
  isGoBizConfigured,
  verifyGoBizWebhookSignature
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
    body: { transaction: { order_id: "RTTBK-GOBIZ-PROD-123-abcdef12" } }
  });
  const secret = "test-webhook-secret";
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  assert.equal(verifyGoBizWebhookSignature(rawBody, signature, secret), true);
  assert.equal(verifyGoBizWebhookSignature(rawBody + " ", signature, secret), false);
  assert.equal(verifyGoBizWebhookSignature(rawBody, "bad", secret), false);
  assert.equal(verifyGoBizWebhookSignature(rawBody, signature, ""), false);
});
