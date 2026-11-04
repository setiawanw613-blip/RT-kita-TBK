"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidIuranMonth } = require("../iuran-validation");

test("menerima bulan valid mulai Oktober 2026", () => {
  assert.equal(isValidIuranMonth("2026-10"), true);
  assert.equal(isValidIuranMonth("2026-11"), true);
  assert.equal(isValidIuranMonth("2027-01"), true);
});

test("menolak bulan di luar format atau rentang kalender", () => {
  for (const value of ["", "2026-00", "2026-13", "2026-1", "2026-99", "2026-09", "2026-10-01", "2026/10", null, 202610]) {
    assert.equal(isValidIuranMonth(value), false, String(value));
  }
});
