"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectImageType } = require("../image-validation");

test("mengenali signature JPEG", () => {
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(detectImageType(data), { mime: "image/jpeg", ext: "jpg" });
});

test("mengenali signature PNG", () => {
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.deepEqual(detectImageType(data), { mime: "image/png", ext: "png" });
});

test("mengenali signature WebP", () => {
  const data = Buffer.from("RIFF0000WEBP", "ascii");
  assert.deepEqual(detectImageType(data), { mime: "image/webp", ext: "webp" });
});

test("menolak MIME palsu, file pendek, dan format tak dikenal", () => {
  assert.equal(detectImageType("not a buffer"), null);
  assert.equal(detectImageType(Buffer.from("short")), null);
  assert.equal(detectImageType(Buffer.from("GIF89a........")), null);
  assert.equal(detectImageType(Buffer.from("RIFF0000WAVE")), null);
});
