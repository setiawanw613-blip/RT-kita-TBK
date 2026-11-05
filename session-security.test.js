"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSignedSessionToken,
  verifySignedSessionToken,
  isValidSessionShape
} = require("./session-security");

const SECRET = "test-session-secret-with-at-least-32-bytes";
const NOW = 1_800_000_000_000;

test("accepts admin and warga sessions", () => {
  const admin = { id: "admin", username: "admin", role: "admin" };
  const warga = { id: 17, wargaId: 17, username: "08123456789", role: "warga" };
  assert.equal(isValidSessionShape({ ...admin, createdAt: NOW }), true);
  assert.equal(isValidSessionShape({ ...warga, createdAt: NOW }), true);
});

test("accepts only the three staff roles with positive numeric IDs", () => {
  for (const role of ["bendahara", "sekretaris", "ketua_gang"]) {
    const session = { id: 21, username: "petugas.rt", role, createdAt: NOW };
    assert.equal(isValidSessionShape(session), true, role);
    const token = createSignedSessionToken(session, SECRET, NOW);
    assert.deepEqual(verifySignedSessionToken(token, SECRET, NOW), session);
  }
  assert.equal(isValidSessionShape({ id: 0, username: "x", role: "sekretaris", createdAt: NOW }), false);
  assert.equal(isValidSessionShape({ id: "abc", username: "x", role: "sekretaris", createdAt: NOW }), false);
});

test("rejects arbitrary roles, tampered tokens, weak secrets, and expired sessions", () => {
  assert.equal(isValidSessionShape({ id: 1, username: "x", role: "superadmin", createdAt: NOW }), false);
  const token = createSignedSessionToken({ id: 1, username: "x", role: "sekretaris" }, SECRET, NOW);
  assert.equal(verifySignedSessionToken(token + "x", SECRET, NOW), null);
  assert.equal(verifySignedSessionToken(token, SECRET, NOW + 8 * 60 * 60 * 1000 + 1), null);
  assert.equal(verifySignedSessionToken(token, "short", NOW), null);
  assert.throws(() => createSignedSessionToken({ id: 1, username: "x", role: "sekretaris" }, "short", NOW));
});
