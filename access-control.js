"use strict";

const OWNER_ROLES = new Set(["warga", "ketua_gang"]);

function canAccessOwnedRecord(session, ownerId) {
  if (!session || (session.role !== "admin" && !OWNER_ROLES.has(session.role))) {
    return false;
  }
  if (session.role === "admin") return true;
  return session.wargaId != null &&
    ownerId != null &&
    String(session.wargaId) === String(ownerId);
}

module.exports = { canAccessOwnedRecord };
