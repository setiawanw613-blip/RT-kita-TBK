const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeStorageObjectPath } = require("../storage-path");

test("accepts a regular private object path", () => {
  assert.equal(normalizeStorageObjectPath("warga/17.jpg", "foto warga"), "warga/17.jpg");
});

test("accepts object metadata used by aspirasi documentation", () => {
  assert.equal(
    normalizeStorageObjectPath({ path: "aspirasi/12/foto-kondisi.jpg" }, "foto warga"),
    "aspirasi/12/foto-kondisi.jpg"
  );
});

test("removes a duplicated bucket prefix", () => {
  assert.equal(normalizeStorageObjectPath("foto warga/warga/17.jpg", "foto warga"), "warga/17.jpg");
});

test("rejects URLs and invalid object types", () => {
  assert.equal(normalizeStorageObjectPath("https://example.com/a.jpg", "foto warga"), null);
  assert.equal(normalizeStorageObjectPath(42, "foto warga"), null);
});

test("rejects empty and traversal paths", () => {
  assert.equal(normalizeStorageObjectPath("  ", "foto warga"), null);
  assert.equal(normalizeStorageObjectPath("../private.jpg", "foto warga"), null);
  assert.equal(normalizeStorageObjectPath("warga/../private.jpg", "foto warga"), null);
});
