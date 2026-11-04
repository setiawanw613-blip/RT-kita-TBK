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

  const response = await fetchImpl(
    `${apiBase}/v2/${encodeURIComponent(orderId)}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(serverKey + ":").toString("base64"),
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    }
  );

  let result = {};
  try {
    result = await response.json();
  } catch {
    // Keep the failure result generic; callers must reconcile status separately.
  }

  return {
    ok: response.ok && result.transaction_status === "cancel",
    status: typeof result.transaction_status === "string"
      ? result.transaction_status
      : null,
    statusCode: response.status
  };
}

module.exports = { cancelPendingMidtransTransaction };
