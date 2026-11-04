async function cancelPendingMidtransTransaction({
  orderId,
  serverKey,
  apiBase,
  fetchImpl = fetch
}) {
  if (
    typeof orderId !== "string" ||
    !/^RTTBK-(?:PROD|SBX)-[0-9]+-[a-f0-9]{8}$/.test(orderId) ||
    typeof serverKey !== "string" ||
    serverKey.length === 0 ||
    typeof apiBase !== "string" ||
    !/^https:\/\/(?:api\.midtrans\.com|api\.sandbox\.midtrans\.com)$/.test(apiBase) ||
    typeof fetchImpl !== "function"
  ) {
    throw new TypeError("Konfigurasi pembatalan transaksi Midtrans tidak valid.");
  }

  const url = `${apiBase}/v2/${encodeURIComponent(orderId)}`;
  const headers = {
    Authorization: "Basic " + Buffer.from(serverKey + ":").toString("base64"),
    Accept: "application/json",
    "Content-Type": "application/json"
  };

  const statusResponse = await fetchImpl(url + "/status", { method: "GET", headers });
  if (!statusResponse.ok) {
    return { ok: false, status: null, statusCode: statusResponse.status, reason: "status_unavailable" };
  }

  const statusBody = await statusResponse.json();
  if (statusBody.transaction_status !== "pending") {
    return {
      ok: false,
      status: typeof statusBody.transaction_status === "string" ? statusBody.transaction_status : null,
      statusCode: statusResponse.status,
      reason: "not_pending"
    };
  }

  const cancelResponse = await fetchImpl(url + "/cancel", { method: "POST", headers });
  let cancelBody = {};
  try {
    cancelBody = await cancelResponse.json();
  } catch {
    // A missing response body is treated as an unconfirmed cancellation.
  }

  return {
    ok: cancelResponse.ok && cancelBody.transaction_status === "cancel",
    status: typeof cancelBody.transaction_status === "string" ? cancelBody.transaction_status : null,
    statusCode: cancelResponse.status,
    reason: cancelResponse.ok ? "cancel_response_unconfirmed" : "cancel_rejected"
  };
}

module.exports = { cancelPendingMidtransTransaction };
