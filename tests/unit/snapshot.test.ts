import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApprovalSnapshot, diffSnapshots, snapshotDigest, type CheckoutView, type ProcurementRequest } from "@procurement/domain";

const request = {
  id: "pr_1",
  version: 2,
  destination_id: "dest_hq",
  delivery_deadline: "2026-10-02T22:00:00.000Z",
} as ProcurementRequest;

function view(shipping: number): CheckoutView {
  return {
    protocol: "acp",
    protocol_version: "2026-01-16",
    merchant_id: "merchant_b",
    native_checkout_id: "cs_1",
    native_status: "ready_for_payment",
    normalized_status: "ready",
    currency: "USD",
    line_items: [{ native_line_id: "li_1", merchant_item_id: "ct-mon-27-ips", title: "Monitor", quantity: 10, unit_minor: 18000, total_minor: 180000 }],
    totals: { subtotal_minor: 180000, tax_minor: 0, shipping_minor: shipping, fees_minor: 0, total_minor: 180000 + shipping },
    delivery_promise: "2026-09-28T12:00:00.000Z",
    fulfillment_option: "ct-2day",
    payment_handler: { id: "stripe", type: "stripe" },
    native_order_id: null,
    messages: [],
    terms: { carrier: "Fixture Freight" },
    native: {},
  };
}

test("changed shipping invalidates the approval digest", () => {
  const a = buildApprovalSnapshot(request, view(10000));
  const b = buildApprovalSnapshot(request, view(12500));
  assert.notEqual(snapshotDigest(a), snapshotDigest(b));
  const diffs = diffSnapshots(a, b);
  assert.ok(diffs.some((d) => d.field === "totals.shipping_minor" && d.approved === 10000 && d.current === 12500));
});

test("identical snapshots share a digest", () => {
  const a = buildApprovalSnapshot(request, view(10000));
  const b = buildApprovalSnapshot(request, view(10000));
  assert.equal(snapshotDigest(a), snapshotDigest(b));
  assert.equal(diffSnapshots(a, b).length, 0);
});
