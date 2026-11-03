// Escape a CSV cell and neutralize spreadsheet formula prefixes in user-controlled text.
function csvCell(value) {
  let text = String(value ?? "");

  // Spreadsheet programs may evaluate cells beginning with formula markers,
  // even when the CSV field is quoted. Prefix an apostrophe only for strings;
  // numeric values remain numeric in spreadsheet imports.
  if (
    typeof value === "string" &&
    /^[\u0000-\u0020]*[=+\-@]/.test(text)
  ) {
    text = "'" + text;
  }

  return '"' + text.replace(/"/g, '""') + '"';
}

module.exports = { csvCell };
