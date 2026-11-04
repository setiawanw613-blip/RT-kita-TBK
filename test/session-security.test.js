"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SESSION_MAX_AGE_MS, createSignedSessionToken, verifySignedSessionToken } = require("../session-security");
const SECRET = "test-only-session-secret";
const NOW = 1_800_000_000_000;

test("menerbitkan dan memverifikasi sesi admin", () => {
  const token = createSignedSessionToken({ id: "admin", username: "ketua", role: "admin" }, SECRET, NOW);
  assert.deepEqual(verifySignedSessionToken(token, SECRET, NOW), { id: "admin", username: "ketua", role: "admin", createdAt: NOW });
});
test("menerbitkan dan memverifikasi sesi warga", () => {
  const token = createSignedSessionToken({ id: 27, wargaId: 27, username: "08123456789", role: "warga" }, SECRET, NOW);
  assert.equal(verifySignedSessionToken(token, SECRET, NOW).wargaId, 27);
});
test("menolak token yang diubah atau secret berbeda", () => {
  const token = createSignedSessionToken({ id: "admin", username: "ketua", role: "admin" }, SECRET, NOW);
  assert.equal(verifySignedSessionToken(token + "x", SECRET, NOW), null);
  assert.equal(verifySignedSessionToken(token, "secret-lain", NOW), null);
});
test("menolak token kedaluwarsa, waktu masa depan, dan token rusak", () => {
  const token = createSignedSessionToken({ id: "admin", username: "ketua", role: "admin" }, SECRET, NOW);
  assert.equal(verifySignedSessionToken(token, SECRET, NOW + SESSION_MAX_AGE_MS + 1), null);
  assert.equal(verifySignedSessionToken(token, SECRET, NOW - 1), null);
  assert.equal(verifySignedSessionToken("bukan-token", SECRET, NOW), null);
  assert.equal(verifySignedSessionToken("x".repeat(9000), SECRET, NOW), null);
});
test("menolak struktur sesi dan peran yang tidak dikenal", () => {
  assert.throws(() => createSignedSessionToken({ id: "admin", username: "ketua", role: "warga" }, SECRET, NOW));
  assert.throws(() => createSignedSessionToken({ id: "x", username: "ketua", role: "superadmin" }, SECRET, NOW));
});
