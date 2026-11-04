"use strict";

const crypto = require("node:crypto");
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 8192;

function isValidSessionShape(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) return false;
  if (!Number.isSafeInteger(session.createdAt) || typeof session.username !== "string" || !session.username.trim()) return false;
  if (session.role === "admin") return session.id === "admin";
  if (session.role === "warga") {
    return session.id !== undefined && session.id !== null &&
      session.wargaId !== undefined && session.wargaId !== null &&
      String(session.id) === String(session.wargaId);
  }
  return false;
}

function createSignedSessionToken(session, secret, now = Date.now()) {
  if (typeof secret !== "string" || !secret) throw new Error("SESSION_SECRET belum dikonfigurasi");
  const payloadObject = { ...session, createdAt: now };
  if (!isValidSessionShape(payloadObject)) throw new Error("Data sesi tidak valid");
  const payload = Buffer.from(JSON.stringify(payloadObject)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySignedSessionToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH ||
      typeof secret !== "string" || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2 ||
      !/^[A-Za-z0-9_-]{1,8000}$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;

  const [payload, signature] = parts;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isValidSessionShape(session)) return null;
    const age = now - session.createdAt;
    if (!Number.isFinite(age) || age < 0 || age > SESSION_MAX_AGE_MS) return null;
    return session;
  } catch {
    return null;
  }
}

module.exports = { SESSION_MAX_AGE_MS, createSignedSessionToken, verifySignedSessionToken };
