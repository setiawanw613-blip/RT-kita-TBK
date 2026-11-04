"use strict";
function isValidIuranMonth(value) {
  return typeof value === "string" &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(value) &&
    value >= "2026-10";
}
module.exports = { isValidIuranMonth };
