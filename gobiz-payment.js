const crypto = require("crypto");

const tokenCache = new Map();
const subscriptionCache = new Map();

function getGoBizConfig(env = process.env) {
  const environment = String(env.GOBIZ_ENVIRONMENT || "sandbox").trim().toLowerCase();
  if (!["sandbox", "production"].includes(environment)) {
    throw new Error("GOBIZ_ENVIRONMENT harus bernilai sandbox atau production.");
  }
  const sandbox = environment === "sandbox";
  return {
    environment: sandbox ? "sandbox" : "production",
    clientId: String(env.GOBIZ_CLIENT_ID || "").trim(),
    clientSecret: String(env.GOBIZ_CLIENT_SECRET || "").trim(),
    outletId: String(env.GOBIZ_OUTLET_ID || "").trim(),
    notificationSecret: String(env.GOBIZ_NOTIFICATION_SECRET_KEY || "").trim(),
    oauthBase: sandbox
      ? "https://integration-goauth.gojekapi.com"
      : "https://accounts.go-jek.com",
    apiBase: sandbox
      ? "https://api.partner-sandbox.gobiz.co.id"
      : "https://api.gobiz.co.id"
  };
}

function isGoBizConfigured(env = process.env) {
  const c = getGoBizConfig(env);
  return Boolean(c.clientId && c.clientSecret && c.outletId && c.notificationSecret);
}

async function getGoBizAccessToken({ fetchImpl = fetch, env = process.env, forceRefresh = false } = {}) {
  const c = getGoBizConfig(env);
  if (!c.clientId || !c.clientSecret) {
    throw new Error("Kredensial GoBiz belum dikonfigurasi di server.");
  }
  const cacheKey = crypto.createHash("sha256")
    .update([c.oauthBase, c.clientId, c.clientSecret].join("\n"))
    .digest("hex");
  const cached = tokenCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() < cached.expiresAt - 60000) {
    return cached.token;
  }

  const form = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "payment:transaction:read payment:transaction:write"
  });
  const response = await fetchImpl(`${c.oauthBase}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    tokenCache.delete(cacheKey);
    console.error("GOBIZ TOKEN ERROR:", response.status);
    throw new Error("Autentikasi GoBiz gagal. Periksa kredensial dan scope API.");
  }
  const token = String(body.access_token);
  const expiresAt = Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000;
  tokenCache.set(cacheKey, { token, expiresAt });
  return token;
}

async function goBizRequest(path, { method = "GET", body, headers: extraHeaders = {}, fetchImpl = fetch, env = process.env } = {}) {
  const c = getGoBizConfig(env);
  let token = await getGoBizAccessToken({ fetchImpl, env });
  const makeRequest = accessToken => fetchImpl(c.apiBase + path, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000)
  });
  let response = await makeRequest(token);
  if (response.status === 401) {
    token = await getGoBizAccessToken({ fetchImpl, env, forceRefresh: true });
    response = await makeRequest(token);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("GOBIZ API ERROR:", { status: response.status, path });
    throw new Error("Permintaan ke GoBiz gagal. Periksa konfigurasi dan status outlet.");
  }
  return data;
}

async function ensureGoBizPaymentWebhook(callbackUrl, { fetchImpl = fetch, env = process.env, forceCheck = false } = {}) {
  const c = getGoBizConfig(env);
  if (!c.outletId || !c.notificationSecret) {
    throw new Error("Outlet ID dan Notification Secret GoBiz belum dikonfigurasi.");
  }
  if (!/^https:\/\//i.test(String(callbackUrl || ""))) {
    throw new Error("Alamat webhook GoBiz harus menggunakan HTTPS.");
  }
  const cacheKey = [c.environment, c.outletId, callbackUrl].join("|");
  const checkedAt = subscriptionCache.get(cacheKey) || 0;
  if (!forceCheck && checkedAt && Date.now() - checkedAt < 10 * 60 * 1000) {
    return true;
  }

  const path = "/integrations/partner/v1/notification-subscriptions";
  const result = await goBizRequest(path, { fetchImpl, env });
  const subscriptions = Array.isArray(result?.data?.subscriptions) ? result.data.subscriptions : [];
  const existing = subscriptions.find(s =>
    s && s.event === "payment.transaction.settlement" &&
    s.url === callbackUrl && s.active === true
  );
  if (!existing) {
    await goBizRequest(path, {
      method: "POST",
      body: { event: "payment.transaction.settlement", url: callbackUrl, active: true },
      fetchImpl,
      env
    });
  }
  subscriptionCache.set(cacheKey, Date.now());
  return true;
}

async function getGoBizTransactionDetail(transactionId, { fetchImpl = fetch, env = process.env } = {}) {
  const c = getGoBizConfig(env);
  if (!c.outletId) throw new Error("Outlet ID GoBiz belum dikonfigurasi.");
  const id = String(transactionId || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("ID transaksi GoBiz tidak valid.");
  }
  const result = await goBizRequest(
    `/integrations/payment/outlets/${encodeURIComponent(c.outletId)}/v1/transactions/${encodeURIComponent(id)}`,
    { fetchImpl, env }
  );
  const transaction = result?.data?.transaction;
  if (
    result?.success !== true ||
    !transaction ||
    String(transaction.id) !== id ||
    String(transaction.payment_type || "").toLowerCase() !== "qris" ||
    String(transaction.currency || "").toUpperCase() !== "IDR" ||
    !transaction.order_id ||
    !Number.isSafeInteger(Number(transaction.gross_amount))
  ) {
    throw new Error("Detail transaksi GoBiz tidak lengkap atau tidak cocok.");
  }
  return { transaction, outlet: result.data.outlet || null };
}

async function createGoBizQrisTransaction({ orderId, total, namaWarga, namaPembayar, fetchImpl = fetch, env = process.env }) {
  const c = getGoBizConfig(env);
  if (!c.outletId) throw new Error("Outlet ID GoBiz belum dikonfigurasi.");
  if (!/^RTTBK-(PROD|SBX)-[0-9]+-[a-f0-9]{8}$/.test(String(orderId || ""))) {
    throw new Error("Referensi transaksi GoBiz tidak valid.");
  }
  if (!Number.isSafeInteger(Number(total)) || Number(total) <= 0) {
    throw new Error("Nominal pembayaran GoBiz tidak valid.");
  }

  const callbackUrl = String(env.GOBIZ_WEBHOOK_URL || "https://rt-kita-tbk.vercel.app/api/gobiz/webhook").trim();
  await ensureGoBizPaymentWebhook(callbackUrl, { fetchImpl, env });

  const idempotencyKey = crypto.createHash("sha256").update(orderId).digest("hex").slice(0, 32);
  const response = await goBizRequest(
    `/integrations/payment/outlets/${encodeURIComponent(c.outletId)}/v2/transactions`,
    {
      method: "POST",
      fetchImpl,
      env,
      headers: { "Idempotency-Key": idempotencyKey },
      body: {
        payment_type: "qris",
        transaction_details: {
          order_id: orderId,
          gross_amount: Number(total),
          currency: "IDR"
        },
        item_details: [{
          id: "IURAN-RT-TBK",
          price: Number(total),
          quantity: 1,
          name: "Iuran Warga RT TBK",
          brand: "RT TBK",
          category: "community"
        }],
        customer_details: {
          first_name: String(namaPembayar || namaWarga || "Warga RT TBK").slice(0, 100)
        },
        metadata: { source: "RT-KITA-TBK", order_id: orderId }
      }
    }
  );

  const transaction = response?.data?.transaction;
  const actions = Array.isArray(response?.data?.actions) ? response.data.actions : [];
  if (
    response?.success !== true ||
    !transaction ||
    transaction.order_id !== orderId ||
    Number(transaction.gross_amount) !== Number(total) ||
    String(transaction.currency || "").toUpperCase() !== "IDR" ||
    String(transaction.payment_type).toLowerCase() !== "qris" ||
    String(response?.data?.outlet?.id || "") !== c.outletId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(transaction.id || ""))
  ) {
    throw new Error("Respons QRIS GoBiz tidak cocok dengan tagihan RT Kita.");
  }

  let qrUrl = null;
  const qrAction = actions.find(a => a && a.name === "generate-qr-code" && a.url);
  if (qrAction) {
    try {
      const actionUrl = new URL(qrAction.url);
      if (actionUrl.protocol !== "https:" || !actionUrl.hostname.endsWith(".gobiz.co.id")) {
        throw new Error("Host QR GoBiz tidak diizinkan.");
      }
      const token = await getGoBizAccessToken({ fetchImpl, env });
      const imageResponse = await fetchImpl(actionUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000)
      });
      const type = String(imageResponse.headers.get("content-type") || "").toLowerCase();
      if (imageResponse.ok && type.startsWith("image/")) {
        const bytes = Buffer.from(await imageResponse.arrayBuffer());
        if (bytes.length > 1024 * 1024) throw new Error("QR GoBiz melebihi batas ukuran.");
        qrUrl = `data:${type};base64,${bytes.toString("base64")}`;
      }
    } catch (error) {
      console.warn("GOBIZ QR IMAGE UNAVAILABLE:", error?.message || error);
    }
  }

  return {
    transaction,
    actions,
    qr_url: qrUrl,
    qr_string: transaction.qris_string || null,
    transaction_status: transaction.status || "pending"
  };
}

function normalizeGoBizTransactionStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isGoBizExpiredStatus(value) {
  return ["expire", "expired", "cancel", "cancelled", "deny", "denied"].includes(
    normalizeGoBizTransactionStatus(value)
  );
}

function isGoBizSettlementStatus(value) {
  return normalizeGoBizTransactionStatus(value) === "settlement";
}

function isGoBizIdrCurrency(value) {
  return String(value || "").trim().toUpperCase() === "IDR";
}

function verifyGoBizWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const supplied = String(signature).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = crypto.createHmac("sha256", String(secret)).update(rawBody).digest();
  const actual = Buffer.from(supplied, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = {
  getGoBizConfig,
  isGoBizConfigured,
  getGoBizAccessToken,
  goBizRequest,
  ensureGoBizPaymentWebhook,
  createGoBizQrisTransaction,
  getGoBizTransactionDetail,
  normalizeGoBizTransactionStatus,
  isGoBizExpiredStatus,
  isGoBizSettlementStatus,
  isGoBizIdrCurrency,
  verifyGoBizWebhookSignature
};
