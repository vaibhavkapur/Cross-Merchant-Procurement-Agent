import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureQuote, compareQuotes, evaluateEligibility, loadMerchants, loadSuppliers, type CapabilitySnapshot } from "@procurement/domain";
import { RFQ_CONTRACT, type RfqRequest } from "@procurement/protocol-contracts";

const now = new Date("2026-09-26T12:00:00Z");
const deadlineFriday = "2026-10-02T22:00:00.000Z";
const merchants = loadMerchants();
const suppliers = loadSuppliers();
const merchantA = merchants.find((m) => m.id === "merchant_a")!;
const merchantB = merchants.find((m) => m.id === "merchant_b")!;
const supplierA = suppliers.find((s) => s.id === "supplier_a")!;
const supplierB = suppliers.find((s) => s.id === "supplier_b")!;

function rfq(id: string, requiredBy = deadlineFriday): RfqRequest {
  return {
    contract: RFQ_CONTRACT,
    rfq_id: id,
    product: { category: "monitor", minimum_size_inches: 27 },
    quantity: 10,
    currency: "USD",
    destination: { destination_id: "dest_hq", country: "US", region: "TX", locality: "Austin", postal_code: "78701" },
    required_delivery_by: requiredBy,
    response_deadline: "2026-09-26T13:00:00Z",
  };
}

const caps: Record<string, CapabilitySnapshot> = {
  merchant_a: { merchant_id: "merchant_a", protocol: "ucp", protocol_version: "2026-08-25", endpoint: "http://x", capabilities: ["checkout"], payment_handlers: ["card"], supports_checkout: true, discovered_at: now.toISOString(), native: {} },
  merchant_b: { merchant_id: "merchant_b", protocol: "acp", protocol_version: "2026-01-16", endpoint: "http://x", capabilities: ["checkout"], payment_handlers: ["stripe"], supports_checkout: true, discovered_at: now.toISOString(), native: {} },
};

const ctx = {
  request: { product: { category: "monitor", minimum_size_inches: 27 }, quantity: 10, currency: "USD", budget_minor: 200000, delivery_deadline: deadlineFriday, allowed_merchants: ["merchant_a", "merchant_b"] },
  approved_merchants: ["merchant_a", "merchant_b"],
  capabilities: caps,
  now,
};

test("demo A: cheaper late quote is ineligible; on-time quote ranks first", () => {
  const a = buildFixtureQuote({ rfq: rfq("a"), supplier: supplierA, merchant: merchantA, now });
  const b = buildFixtureQuote({ rfq: rfq("b"), supplier: supplierB, merchant: merchantB, now });
  assert.equal(a.price.total_minor, 170800);
  assert.equal(b.price.total_minor, 190000);
  const outcomes = compareQuotes(
    [
      { quote_id: "qa", artifact: a },
      { quote_id: "qb", artifact: b },
    ],
    ctx,
  );
  const oa = outcomes.find((o) => o.quote_id === "qa")!;
  const ob = outcomes.find((o) => o.quote_id === "qb")!;
  assert.equal(oa.eligibility.eligible, false);
  assert.ok(oa.eligibility.failed.includes("delivery_deadline"));
  assert.match(oa.ranking.summary, /delivery_deadline/);
  assert.equal(ob.eligibility.eligible, true);
  assert.equal(ob.ranking.rank, 1);
});

test("missing delivery date is unknown, not an implied promise", () => {
  const a = buildFixtureQuote({ rfq: rfq("a"), supplier: supplierB, merchant: merchantB, now });
  a.delivery.promised_by = null;
  const el = evaluateEligibility({ quote_id: "q", artifact: a }, ctx);
  assert.equal(el.eligible, false);
  assert.ok(el.failed.includes("delivery_deadline"));
  assert.match(el.checks.find((c) => c.constraint === "delivery_deadline")!.detail, /did not promise/);
});

test("wrong currency and expired quote fail hard constraints", () => {
  const q = buildFixtureQuote({ rfq: rfq("a"), supplier: supplierB, merchant: merchantB, now });
  q.price.currency = "EUR";
  q.expires_at = "2026-09-26T11:00:00Z";
  const el = evaluateEligibility({ quote_id: "q", artifact: q }, ctx);
  assert.ok(el.failed.includes("currency"));
  assert.ok(el.failed.includes("quote_unexpired"));
});

test("no selected quote violates a hard constraint", () => {
  const later = "2026-10-20T22:00:00.000Z";
  const a = buildFixtureQuote({ rfq: rfq("a", later), supplier: supplierA, merchant: merchantA, now });
  const b = buildFixtureQuote({ rfq: rfq("b", later), supplier: supplierB, merchant: merchantB, now });
  const outcomes = compareQuotes(
    [
      { quote_id: "qa", artifact: a },
      { quote_id: "qb", artifact: b },
    ],
    { ...ctx, request: { ...ctx.request, delivery_deadline: later } },
  );
  const winner = outcomes.find((o) => o.ranking.rank === 1)!;
  assert.equal(winner.eligibility.eligible, true);
  assert.equal(winner.quote_id, "qa");
  assert.ok(winner.ranking.delivered_total_minor <= 200000);
});

test("delivered total includes every configured charge", () => {
  const q = buildFixtureQuote({ rfq: rfq("b"), supplier: supplierB, merchant: merchantB, now });
  assert.equal(q.price.subtotal_minor + q.price.tax_minor + q.price.shipping_minor, q.price.total_minor);
});
