import assert from "node:assert/strict";
import { test } from "node:test";
import { addMinor, formatMinor, mulMinor, parseMinor, subMinor } from "@procurement/domain";

test("parseMinor accepts decimal strings", () => {
  assert.equal(parseMinor("200000"), 200000);
  assert.equal(parseMinor(190000), 190000);
});

test("addMinor is exact and rejects overflow", () => {
  assert.equal(addMinor(170000, 0, 800), 170800);
  assert.throws(() => addMinor(Number.MAX_SAFE_INTEGER, 1));
});

test("subMinor and mulMinor stay in integer space", () => {
  assert.equal(subMinor(250000, 190000), 60000);
  assert.equal(mulMinor(18000, 10), 180000);
});

test("formatMinor renders USD cents", () => {
  assert.equal(formatMinor(190000, "USD"), "1,900.00 USD");
  assert.equal(formatMinor(800, "USD"), "8.00 USD");
});
