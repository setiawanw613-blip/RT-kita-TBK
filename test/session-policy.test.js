"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SESSION_MAX_AGE_MS, isValidSession } = require("../session-policy");

const now = 1_800_000_000_000;
const admin = {
  id: "admin",
  username: "admin",
  role: "admin",
  createdAt: now
};
const warga = {
  id: "warga-123",
  wargaId: "warga-123",
  username: "08123456789",
  role: "warga",
  createdAt: now
};

test("menerima sesi admin dan warga yang sah", () => {
  assert.equal(isValidSession(admin, now), true);
  assert.equal(isValidSession(warga, now), true);
});

test("menolak sesi kosong, bukan objek, atau array", () => {
  assert.equal(isValidSession(null, now), false);
  assert.equal(isValidSession("session", now), false);
  assert.equal(isValidSession([], now), false);
});

test("menolak sesi tanpa waktu pembuatan yang valid", () => {
  for (const createdAt of [undefined, null, 0, -1, NaN, Infinity, "1800000000000"]) {
    assert.equal(isValidSession({ ...admin, createdAt }, now), false);
  }
});

test("menolak sesi dari masa depan dan sesi yang sudah kedaluwarsa", () => {
  assert.equal(isValidSession({ ...admin, createdAt: now + 1 }, now), false);
  assert.equal(
    isValidSession({ ...admin, createdAt: now - SESSION_MAX_AGE_MS - 1 }, now),
    false
  );
});

test("menerima sesi tepat pada batas umur maksimum", () => {
  assert.equal(
    isValidSession({ ...admin, createdAt: now - SESSION_MAX_AGE_MS }, now),
    true
  );
});

test("menolak role palsu dan identitas admin yang tidak cocok", () => {
  assert.equal(isValidSession({ ...admin, role: "superadmin" }, now), false);
  assert.equal(isValidSession({ ...admin, id: "warga-123" }, now), false);
});

test("menolak sesi warga tanpa kecocokan ID warga", () => {
  assert.equal(isValidSession({ ...warga, wargaId: "warga-lain" }, now), false);
  assert.equal(isValidSession({ ...warga, wargaId: "" }, now), false);
  assert.equal(isValidSession({ ...warga, wargaId: undefined }, now), false);
});

test("menolak username kosong atau terlalu panjang", () => {
  assert.equal(isValidSession({ ...admin, username: " " }, now), false);
  assert.equal(isValidSession({ ...admin, username: "x".repeat(121) }, now), false);
});
