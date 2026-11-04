"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRateLimitKey } = require("../rate-limit-key");

const SECRET = "a".repeat(64);

test("rate-limit key is deterministic and does not expose the identifier", () => {
  const key = createRateLimitKey(SECRET, "register", "081234567890");
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, createRateLimitKey(SECRET, "register", "081234567890"));
  assert.equal(key.includes("081234567890"), false);
});

test("rate-limit scopes and identifiers are isolated", () => {
  const login = createRateLimitKey(SECRET, "login", "admin");
  const register = createRateLimitKey(SECRET, "register", "admin");
  const otherUser = createRateLimitKey(SECRET, "login", "warga");
  assert.notEqual(login, register);
  assert.notEqual(login, otherUser);
});

test("rate-limit identifiers are normalized consistently", () => {
  assert.equal(createRateLimitKey(SECRET, "login", " ADMIN "), createRateLimitKey(SECRET, "login", "admin"));
});

test("invalid secrets, scopes, and identifiers are rejected", () => {
  assert.throws(() => createRateLimitKey("short", "login", "admin"));
  assert.throws(() => createRateLimitKey(SECRET, "bad scope", "admin"));
  assert.throws(() => createRateLimitKey(SECRET, "login", "  "));
});
