const test = require("node:test");
const assert = require("node:assert/strict");
const { csvCell } = require("../csv-safe");

test("quotes CSV values and doubles embedded quotes", () => {
  assert.equal(csvCell('Wawan "RT"'), '"Wawan ""RT"""');
});

test("neutralizes spreadsheet formulas in user-controlled text", () => {
  for (const value of ["=1+1", "+cmd", "-2+3", "@SUM(A1:A2)", "  =HYPERLINK(\"x\")"]) {
    assert.equal(csvCell(value).startsWith('"\''), true);
  }
});

test("preserves ordinary text and numeric values", () => {
  assert.equal(csvCell("Wawan Setiawan"), '"Wawan Setiawan"');
  assert.equal(csvCell(35000), '"35000"');
  assert.equal(csvCell(-35000), '"-35000"');
});

test("handles empty and null values", () => {
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
});
