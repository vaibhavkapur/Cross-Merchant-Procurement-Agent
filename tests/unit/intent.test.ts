import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCompany } from "@procurement/domain";
import { extractIntent, resolveDeadline } from "../../apps/api/src/intent.ts";

const company = loadCompany();
const now = new Date("2026-09-26T15:00:00Z");

test("extracts the demo request into explicit constraints", () => {
  const intent = extractIntent({
    text: "Buy 10 monitors, at least 27 inch, total ≤ $2,000 including delivery, delivered to HQ before Friday, charge IT Hardware",
    company,
    now,
  });
  assert.equal(intent.product.category, "monitor");
  assert.equal(intent.product.minimum_size_inches, 27);
  assert.equal(intent.quantity, 10);
  assert.equal(intent.budget_minor, 200000);
  assert.equal(intent.cost_center_id, "cc_it_hardware");
  assert.equal(intent.destination_id, "dest_hq");
  assert.ok(intent.delivery_deadline);
  assert.equal(intent.clarifications.length, 0);
});

test("resolves Friday to the next Friday at 17:00 in the destination zone", () => {
  const iso = resolveDeadline("friday", now, "America/Chicago");
  assert.ok(iso);
  const d = new Date(iso);
  assert.equal(d.getUTCDay(), 5); // Friday
});

test("asks for clarification when a hard constraint is missing", () => {
  const intent = extractIntent({ text: "we need some screens", company, now });
  assert.ok(intent.clarifications.length > 0);
  assert.ok(intent.quantity === null || intent.budget_minor === null);
});
