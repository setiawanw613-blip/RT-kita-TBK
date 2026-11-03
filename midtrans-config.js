const SANDBOX_API = "https://api.sandbox.midtrans.com";
const PRODUCTION_API = "https://api.midtrans.com";

function isProduction(env = process.env) {
  return env.MIDTRANS_IS_PRODUCTION === "true";
}

function getMidtransApiBaseForNewTransaction(env = process.env) {
  return isProduction(env) ? PRODUCTION_API : SANDBOX_API;
}

function getMidtransApiBaseForOrder(orderId) {
  const id = String(orderId || "");
  if (id.startsWith("RTTBK-PROD-")) return PRODUCTION_API;
  if (id.startsWith("RTTBK-SBX-")) return SANDBOX_API;

  // Order IDs created before environment prefixes were sandbox transactions.
  return SANDBOX_API;
}

function getMidtransServerKeyForNewTransaction(env = process.env) {
  if (isProduction(env)) {
    // Never fall back to the Sandbox key for real-money transactions.
    return String(env.MIDTRANS_PRODUCTION_SERVER_KEY || "").trim();
  }
  return String(env.MIDTRANS_SANDBOX_SERVER_KEY || env.MIDTRANS_SERVER_KEY || "").trim();
}

function getMidtransServerKeyForOrder(orderId, env = process.env) {
  const id = String(orderId || "");
  if (id.startsWith("RTTBK-PROD-")) {
    return String(env.MIDTRANS_PRODUCTION_SERVER_KEY || "").trim();
  }
  return String(env.MIDTRANS_SANDBOX_SERVER_KEY || env.MIDTRANS_SERVER_KEY || "").trim();
}

function getMidtransModeInfo(env = process.env) {
  return {
    mode: isProduction(env) ? "production" : "sandbox",
    configured: Boolean(getMidtransServerKeyForNewTransaction(env))
  };
}

module.exports = {
  getMidtransApiBaseForNewTransaction,
  getMidtransApiBaseForOrder,
  getMidtransServerKeyForNewTransaction,
  getMidtransServerKeyForOrder,
  getMidtransModeInfo
};
