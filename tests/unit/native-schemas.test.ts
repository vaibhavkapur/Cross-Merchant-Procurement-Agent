import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acpExamples,
  validateAcp,
  validateQuoteArtifact,
  validateRfqRequest,
  validateUcpBusinessProfile,
  validateUcpCheckoutRequest,
  RFQ_CONTRACT,
  QUOTE_CONTRACT,
} from "@procurement/protocol-contracts";

test("ACP native examples validate independently against 2026-01-16", () => {
  const ex = acpExamples() as Record<string, unknown>;
  const map = {
    create_checkout_session_request: "CheckoutSessionCreateRequest",
    create_checkout_session_response: "CheckoutSession",
    complete_checkout_session_request: "CheckoutSessionCompleteRequest",
    complete_checkout_session_response: "CheckoutSessionWithOrder",
    error_400_requires_3ds: "Error",
  } as const;
  for (const [key, def] of Object.entries(map)) {
    if (!(key in ex)) continue;
    const r = validateAcp(def, ex[key]);
    assert.equal(r.ok, true, `${key}: ${r.ok ? "" : r.errors.join("; ")}`);
  }
});

test("UCP create request validates a minimal line-item payload", () => {
  const ok = validateUcpCheckoutRequest("create", { line_items: [{ item: { id: "item_123" }, quantity: 2 }] });
  assert.equal(ok.ok, true, ok.ok ? "" : ok.errors.join("; "));
});

test("UCP business profile validates", () => {
  const r = validateUcpBusinessProfile({
    ucp: {
      version: "2026-08-25",
      services: { "dev.ucp.shopping": [{ version: "2026-08-25", spec: "https://ucp.dev/specification/shopping/", transport: "rest", endpoint: "http://localhost:4031/ucp/shopping" }] },
      capabilities: { "dev.ucp.shopping.checkout": [{ version: "2026-08-25", spec: "https://ucp.dev/specification/checkout/", schema: "https://ucp.dev/schemas/shopping/checkout.json" }] },
      payment_handlers: {},
    },
  });
  assert.equal(r.ok, true, r.ok ? "" : r.errors.join("; "));
});

test("RFQ and quote application contracts reject untrusted extra fields", () => {
  const rfq = validateRfqRequest({ contract: RFQ_CONTRACT });
  assert.equal(rfq.ok, false);
  const quote = validateQuoteArtifact({ contract: QUOTE_CONTRACT, extra: true });
  assert.equal(quote.ok, false);
});
