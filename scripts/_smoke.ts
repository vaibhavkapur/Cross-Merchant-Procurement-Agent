import { validateAcp, acpExamples, validateUcpCheckoutResponse, validateUcpCheckoutRequest, validateUcpBusinessProfile, validateUcpErrorResponse, resolveUcpSchema, validateQuoteArtifact, intersectCapabilities } from "@procurement/protocol-contracts";
const ex = acpExamples() as Record<string, unknown>;
const map: Record<string, any> = {
  create_checkout_session_request: "CheckoutSessionCreateRequest",
  create_checkout_session_response: "CheckoutSession",
  update_checkout_session_request: "CheckoutSessionUpdateRequest",
  update_checkout_session_response: "CheckoutSession",
  complete_checkout_session_request: "CheckoutSessionCompleteRequest",
  complete_checkout_session_response: "CheckoutSessionWithOrder",
  get_checkout_session_response: "CheckoutSession",
  cancel_checkout_session_response: "CheckoutSession",
  error_400_requires_3ds: "Error",
};
for (const [k, def] of Object.entries(map)) {
  const r = validateAcp(def, ex[k]);
  console.log("ACP", k, r.ok ? "ok" : r.errors);
}
const ucpCreateReq = { line_items: [{ item: { id: "item_123" }, quantity: 2 }] };
console.log("UCP create req", validateUcpCheckoutRequest("create", ucpCreateReq));
console.log("UCP create req (bad: has id)", validateUcpCheckoutRequest("create", { line_items: [{ id: "li_1", item: { id: "x" }, quantity: 1 }] }).ok);
const ucpUpdateReq = { buyer: { email: "jane@example.com", first_name: "Jane", last_name: "Doe" }, line_items: [{ item: { id: "item_123" }, id: "li_1", quantity: 2 }], fulfillment: { methods: [{ type: "shipping", destinations: [{ street_address: "123 Main St", address_locality: "Springfield", address_region: "IL", postal_code: "62701", address_country: "US" }] }] } };
console.log("UCP update req", validateUcpCheckoutRequest("update", ucpUpdateReq));
const ucpComplete = { payment: { instruments: [{ id: "pi_1", handler_id: "gpay_1234", type: "card", selected: true, credential: { type: "PAYMENT_GATEWAY", token: "tok" }, billing_address: { street_address: "1", address_locality: "A", address_region: "CA", address_country: "US", postal_code: "12345" } }] } };
console.log("UCP complete req", validateUcpCheckoutRequest("complete", ucpComplete));
const resp = {
  ucp: { version: "2026-08-25", capabilities: { "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }] }, payment_handlers: { "com.example.sim": [{ id: "sim_1", version: "2026-08-25", config: { merchant_id: "m" } }] } },
  id: "chk_1", status: "completed", currency: "USD",
  order: { id: "ord_1", permalink_url: "https://merchant.example/orders/ord_1" },
  line_items: [{ id: "li_1", item: { id: "item_123", title: "Red", price: 2500 }, quantity: 2, totals: [{ type: "subtotal", amount: 5000 }, { type: "total", amount: 5000 }] }],
  totals: [{ type: "subtotal", amount: 5000 }, { type: "tax", amount: 400 }, { type: "total", amount: 5400 }],
  links: [{ type: "terms_of_service", url: "https://merchant.example/terms" }],
  fulfillment: { methods: [{ id: "shipping_1", type: "shipping", line_item_ids: ["li_1"], selected_destination_id: "dest_home", destinations: [{ type: "shipping_address", id: "dest_home", street_address: "123", address_locality: "S", address_region: "IL", postal_code: "62701", address_country: "US" }], groups: [{ id: "package_1", line_item_ids: ["li_1"], selected_option_id: "express", options: [{ id: "express", title: "Express", totals: [{ type: "total", amount: 1000 }] }] }] }] },
  payment: { instruments: [{ id: "pi_1", handler_id: "sim_1", type: "card", selected: true }] },
  messages: [{ type: "error", code: "missing", path: "$.buyer.email", content: "x", severity: "recoverable" }],
};
console.log("UCP response", validateUcpCheckoutResponse(resp));
console.log("UCP response bad totals", validateUcpCheckoutResponse({ ...resp, totals: [{ type: "tax", amount: 1 }] }).errors.slice(0,3));
console.log("UCP profile", validateUcpBusinessProfile({ ucp: { version: "2026-08-25", services: { "dev.ucp.shopping": [{ version: "2026-08-25", transport: "rest", endpoint: "http://localhost:4101/ucp" }] }, capabilities: { "dev.ucp.shopping.checkout": [{ version: "2026-08-25", schema: "https://ucp.dev/2026-08-25/schemas/shopping/checkout.json" }] }, payment_handlers: {} } }));
console.log("UCP error", validateUcpErrorResponse({ ucp: { version: "2026-08-25", status: "error" }, messages: [{ type: "error", code: "out_of_stock", content: "x", severity: "unrecoverable" }] }));
console.log("intersect", intersectCapabilities({ "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }], "dev.ucp.shopping.fulfillment": [{ version: "2026-08-25", extends: "dev.ucp.shopping.checkout" }] }, { "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }], "dev.ucp.shopping.fulfillment": [{ version: "2026-08-25", extends: "dev.ucp.shopping.checkout" }], "dev.ucp.shopping.discount": [{ version: "2026-08-25", extends: "dev.ucp.shopping.checkout" }] }));
const s = resolveUcpSchema("shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout", "request", "create");
console.log("derived defs:", Object.keys(s.$defs as object).length, JSON.stringify((s.$defs as any).shopping_checkout.properties.line_items), JSON.stringify((s.$defs as any).shopping_types_line_item));
console.log("quote", validateQuoteArtifact({}).errors.length > 0);
