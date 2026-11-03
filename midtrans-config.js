const SANDBOX_API = "https://api.sandbox.midtrans.com";
const PRODUCTION_API = "https://api.midtrans.com";

function isProduction(env = process.env) {
  return env.MIDTRANS_IS_PRODUCTION === "true";
}

function getMidtransApiBaseForNewTransaction(env = process.env) {
  return isProduction(env) ? PRODUCTION_API : SANDBOX_API;
}

function getMidtransApiBaseForOrder(orderId, env = process.env) {
  const id = String(orderId || "");
  if (id.startsWith("RTTBK-PROD-")) return PRODUCTION_API;
  if (id.startsWith("RTTBK-SBX-")) return SANDBOX_API;

  // Order IDs created before environment prefixes were sandbox transactions.
  return SANDBOX_API;
}

function getMidtransModeInfo(env = process.env) {
  return {
    mode: isProduction(env) ? "production" : "sandbox",
    configured: Boolean(env.MIDTRANS_SERVER_KEY)
  };
}

module.exports = {
  getMidtransApiBaseForNewTransaction,
  getMidtransApiBaseForOrder,
  getMidtransModeInfo
};
