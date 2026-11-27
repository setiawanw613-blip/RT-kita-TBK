"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("menu QRIS setoran Ketua Gang tetap nonaktif selama pembayaran dikunci", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const matcher = new RegExp("<button[^>]*disabled[^>]*>[^<]*QRIS Setoran[^<]*</button>", "g");
  const buttons = [...html.matchAll(matcher)];
  assert.equal(buttons.length, 2);
  for (const [markup] of buttons) {
    assert.match(markup, /aria-disabled="true"/);
    assert.match(markup, /rekening RT dan aktivasi Midtrans siap/);
  }
});
