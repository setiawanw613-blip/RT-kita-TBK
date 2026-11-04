"use strict";

const crypto = require("node:crypto");

function createRateLimitKey(secret, scope, identifier) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Rate-limit secret must contain at least 32 bytes");
  }
  if (typeof scope !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(scope)) {
    throw new Error("Rate-limit scope is invalid");
  }
  if (typeof identifier !== "string" || !identifier.trim() || identifier.length > 256) {
    throw new Error("Rate-limit identifier is invalid");
  }

  return crypto.createHmac("sha256", secret)
    .update(scope + ":" + identifier.trim().toLowerCase())
    .digest("hex");
}

module.exports = { createRateLimitKey };
