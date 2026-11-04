"use strict";

function canAccessOwnedRecord(session, ownerId) {
  if (!session || (session.role !== "admin" && session.role !== "warga")) {
    return false;
  }
  if (session.role === "admin") return true;
  return session.wargaId != null &&
    ownerId != null &&
    String(session.wargaId) === String(ownerId);
}

module.exports = { canAccessOwnedRecord };
