"use strict";

/**
 * Detect a second successful Midtrans charge for an already-paid iuran row.
 * The transaction ID is authoritative when available: an older order's late
 * settlement can leave bukti_transfer pointing at the replacement order.
 */
function findConflictingSettledRows(rows, orderId, transactionId) {
  if (!Array.isArray(rows) || typeof orderId !== "string" || !orderId) {
    return [];
  }

  const expectedMarker = `MIDTRANS:${orderId}`;
  return rows.filter(row => {
    if (!row || row.status !== "lunas") return false;
    if (
      typeof transactionId === "string" &&
      transactionId &&
      typeof row.midtrans_transaction_id === "string" &&
      row.midtrans_transaction_id
    ) {
      return row.midtrans_transaction_id !== transactionId;
    }
    return row.bukti_transfer !== expectedMarker;
  });
}

module.exports = { findConflictingSettledRows };
