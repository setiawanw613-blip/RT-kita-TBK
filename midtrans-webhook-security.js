"use strict";

const crypto = require("node:crypto");

function isValidMidtransSignature({ orderId, statusCode, grossAmount, signatureKey, serverKey }) {
  if (
    typeof orderId !== "string" || !orderId ||
    typeof statusCode !== "string" || !statusCode ||
    typeof grossAmount !== "string" || !grossAmount ||
    typeof signatureKey !== "string" || !/^[a-f0-9]{128}$/i.test(signatureKey) ||
    typeof serverKey !== "string" || !serverKey
  ) return false;

  const expected = crypto.createHash("sha512")
    .update(orderId + statusCode + grossAmount + serverKey)
    .digest();
  const supplied = Buffer.from(signatureKey, "hex");

  return supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);
}

function isSuccessfulMidtransStatus(transactionStatus, fraudStatus) {
  return transactionStatus === "settlement" ||
    (transactionStatus === "capture" && fraudStatus === "accept");
}

module.exports = { isValidMidtransSignature, isSuccessfulMidtransStatus };
