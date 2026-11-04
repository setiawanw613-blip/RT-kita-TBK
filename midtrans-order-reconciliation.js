"use strict";

/**
 * Finds iuran rows already settled under a different Midtrans order.
 * This protects a replaced QRIS order from being silently charged twice.
 */
function findConflictingSettledRows(rows, orderId) {
  if (!Array.isArray(rows) || typeof orderId !== "string" || !orderId) {
    return [];
  }

  const expectedMarker = `MIDTRANS:${orderId}`;
  return rows.filter(row =>
    row &&
    row.status === "lunas" &&
    row.bukti_transfer !== expectedMarker
  );
}

module.exports = { findConflictingSettledRows };
