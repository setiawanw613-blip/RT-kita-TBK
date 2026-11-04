"use strict";

const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/**
 * Validate the signed session payload after its HMAC has been checked.
 * Keep this function pure so the security boundary can be tested without
 * loading the production server or requiring live Supabase credentials.
 */
function isValidSession(session, now = Date.now()) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return false;
  }

  if (
    !Number.isSafeInteger(session.createdAt) ||
    session.createdAt <= 0 ||
    !Number.isFinite(now)
  ) {
    return false;
  }

  const age = now - session.createdAt;
  if (age < 0 || age > SESSION_MAX_AGE_MS) return false;

  if (
    typeof session.username !== "string" ||
    session.username.trim().length === 0 ||
    session.username.length > 120
  ) {
    return false;
  }

  if (session.role === "admin") {
    return session.id === "admin";
  }

  if (session.role === "warga") {
    return (
      session.id !== null &&
      session.id !== undefined &&
      session.wargaId !== null &&
      session.wargaId !== undefined &&
      String(session.wargaId).length > 0 &&
      String(session.id) === String(session.wargaId)
    );
  }

  return false;
}

module.exports = { SESSION_MAX_AGE_MS, isValidSession };
