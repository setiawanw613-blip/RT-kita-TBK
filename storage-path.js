function normalizeStorageObjectPath(value, bucketName) {
  if (!value) return null;

  let pathValue = value;
  if (pathValue && typeof pathValue === "object") {
    pathValue =
      pathValue.path ||
      pathValue.fullPath ||
      pathValue.full_path ||
      pathValue.name ||
      null;
  }

  if (typeof pathValue !== "string") return null;

  pathValue = pathValue.trim().replace(/^\/+/, "");
  if (!pathValue || /^https?:\/\//i.test(pathValue)) return null;

  const segments = pathValue.split("/").filter(Boolean);
  if (segments[0] === bucketName) segments.shift();

  if (
    !segments.length ||
    segments.some(segment => segment === "." || segment === "..")
  ) {
    return null;
  }

  return segments.join("/");
}

module.exports = { normalizeStorageObjectPath };
