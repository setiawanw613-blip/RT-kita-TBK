const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidNewResidentPassword } = require("../password-policy");

test("accepts passwords from 8 through 1024 characters", () => {
  assert.equal(isValidNewResidentPassword("12345678"), true);
  assert.equal(isValidNewResidentPassword("a".repeat(1024)), true);
});

test("rejects passwords shorter than 8 characters", () => {
  for (const value of ["", "1", "1234567"]) {
    assert.equal(isValidNewResidentPassword(value), false);
  }
});

test("rejects passwords longer than 1024 characters", () => {
  assert.equal(isValidNewResidentPassword("a".repeat(1025)), false);
});

test("rejects non-string password values", () => {
  for (const value of [null, undefined, 12345678, {}, []]) {
    assert.equal(isValidNewResidentPassword(value), false);
  }
});
