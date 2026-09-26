/**
 * Fixture merchant implementing the Universal Commerce Protocol, release
 * v2026-08-25 — Shopping service over the REST binding, with the checkout and
 * fulfillment capabilities (see packages/protocol-contracts/vendor/ucp).
 *
 *   GET  /.well-known/ucp                              business profile
 *   POST /ucp/shopping/checkout-sessions               create
 *   GET  /ucp/shopping/checkout-sessions/{id}          read
 *   PUT  /ucp/shopping/checkout-sessions/{id}          update (full replacement)
 *   POST /ucp/shopping/checkout-sessions/{id}/complete complete
 *   POST /ucp/shopping/checkout-sessions/{id}/cancel   cancel
 *
 * Every request must carry `UCP-Agent: profile="<platform /.well-known/ucp>"`;
 * the merchant fetches that profile and negotiates capabilities by exact
 * version intersection, echoing the negotiated set in `ucp.capabilities`.
 * Business outcomes (out of stock, payment failure) are HTTP 200 with
 * `messages`; protocol failures use `error_response`.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { loadMerchants, type MerchantFixture, type SimulationFlags } from "@procurement/domain";
import {
  UCP_CHECKOUT_CAPABILITY,
  UCP_FULFILLMENT_CAPABILITY,
  UCP_SHOPPING_SERVICE,
  UCP_VERSION,
  intersectCapabilities,
  validateUcpBusinessProfile,
  validateUcpCheckoutRequest,
  validateUcpCheckoutResponse,
  type UcpBusinessProfile,
  type UcpCapabilityDecl,
  type UcpCheckout,
  type UcpCheckoutRequest,
  type UcpCompleteRequest,
  type UcpErrorResponse,
  type UcpFulfillmentMethod,
  type UcpLineItem,
  type UcpMessage,
  type UcpMessageSeverity,
  type UcpTotal,
} from "@procurement/protocol-contracts";

interface StoredCheckout {
  checkout: UcpCheckout;
  simulation: SimulationFlags;
  reads: number;
  shipping_increase_applied: boolean;
  drop_used: boolean;
  payment_events: Array<{ at: string; event: string; token_fingerprint: string }>;
  negotiated: Record<string, UcpCapabilityDecl[]>;
}

interface IdemRecord {
  request_hash: string;
  status: number;
  body: unknown;
  in_flight: boolean;
}

export interface MerchantUcpOptions {
  merchant?: MerchantFixture;
  apiKey?: string;
  clock?: () => Date;
  logger?: boolean;
  /** Fetch used to retrieve the platform profile named in UCP-Agent (injectable for tests). */
  fetchImpl?: typeof fetch;
}

let seq = 0;
const nextId = (p: string): string => `${p}_${Date.now().toString(36)}_${(++seq).toString(36)}`;
const hashBody = (body: unknown): string => createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");

export function buildMerchantUcp(opts: MerchantUcpOptions = {}): FastifyInstance {
  const merchant = opts.merchant ?? loadMerchants().find((m) => m.protocol === "ucp")!;
  const apiKey = opts.apiKey ?? process.env[merchant.api_key_env] ?? merchant.api_key_default;
  const clock = opts.clock ?? (() => new Date());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const handler = merchant.payment_handler ?? { id: "fixture_card_handler", name: "dev.ucp.fixture_card", version: UCP_VERSION };
  const checkouts = new Map<string, StoredCheckout>();
  const orders = new Map<string, { order_id: string; checkout_id: string; created_at: string }>();
  const idem = new Map<string, IdemRecord>();
  const profileCache = new Map<string, { at: number; capabilities: Record<string, UcpCapabilityDecl[]> }>();

  const app = Fastify({ logger: opts.logger ?? false });

  const businessCapabilities: Record<string, UcpCapabilityDecl[]> = {
    [UCP_CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION, spec: "https://ucp.dev/specification/checkout/", schema: "https://ucp.dev/schemas/shopping/checkout.json" }],
    [UCP_FULFILLMENT_CAPABILITY]: [{ version: UCP_VERSION, spec: "https://ucp.dev/specification/fulfillment/", schema: "https://ucp.dev/schemas/shopping/fulfillment.json", extends: UCP_CHECKOUT_CAPABILITY }],
  };
  const paymentHandlers = {
    [handler.name]: [{ id: handler.id, version: handler.version, spec: `${merchant.base_url}/fixture/payment-handler-spec`, config: { merchant_id: merchant.id, accepted_credential_types: ["fixture_card_token"] } }],
  };

  const profile: UcpBusinessProfile = {
    ucp: {
      version: UCP_VERSION,
      services: { [UCP_SHOPPING_SERVICE]: [{ version: UCP_VERSION, spec: "https://ucp.dev/specification/shopping/", transport: "rest", endpoint: `${merchant.base_url}/ucp/shopping` }] },
      capabilities: businessCapabilities,
      payment_handlers: paymentHandlers,
    },
  };
  {
    const v = validateUcpBusinessProfile(profile);
    if (!v.ok) throw new Error(`fixture UCP profile invalid: ${v.errors.join("; ")}`);
  }

  // ---- helpers ---------------------------------------------------------------------------
  const send = (reply: FastifyReply, status: number, body: unknown): FastifyReply => reply.code(status).header("content-type", "application/json").send(body);

  const errorResponse = (code: string, content: string, severity: UcpMessageSeverity = "unrecoverable"): UcpErrorResponse => ({
    ucp: { version: UCP_VERSION, status: "error" },
    messages: [{ type: "error", code, content, content_type: "plain", severity }],
  });

  const parseAgentProfile = (req: FastifyRequest): string | null => {
    const raw = req.headers["ucp-agent"];
    if (typeof raw !== "string") return null;
    // RFC 8941 dictionary: profile="https://…/.well-known/ucp"
    const m = /profile="([^"]+)"/.exec(raw);
    return m?.[1] ?? null;
  };

  const negotiate = async (profileUrl: string): Promise<{ capabilities: Record<string, UcpCapabilityDecl[]>; warning: UcpMessage | null }> => {
    const cached = profileCache.get(profileUrl);
    if (cached && clock().getTime() - cached.at < 60_000) return { capabilities: cached.capabilities, warning: null };
    try {
      const url = new URL(profileUrl);
      if (!url.pathname.endsWith("/.well-known/ucp")) throw new Error("UCP-Agent profile must point to /.well-known/ucp");
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`profile fetch returned ${res.status}`);
      const doc = (await res.json()) as { ucp?: { capabilities?: Record<string, UcpCapabilityDecl[]> } };
      const platformCaps = doc.ucp?.capabilities ?? {};
      const negotiated = intersectCapabilities(platformCaps, businessCapabilities);
      const capabilities: Record<string, UcpCapabilityDecl[]> = {};
      for (const c of negotiated) capabilities[c.name] = [{ version: c.version, ...(c.extends ? { extends: c.extends } : {}) }];
      profileCache.set(profileUrl, { at: clock().getTime(), capabilities });
      return { capabilities, warning: null };
    } catch (err) {
      return {
        capabilities: { [UCP_CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION }] },
        warning: { type: "warning", code: "profile_unavailable", content: `Could not negotiate capabilities from ${profileUrl}: ${err instanceof Error ? err.message : String(err)}; base checkout only`, content_type: "plain" },
      };
    }
  };

  const authorize = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (req.headers["x-api-key"] !== apiKey) {
      send(reply, 401, errorResponse("insufficient_scope", "Missing or invalid X-API-Key"));
      return null;
    }
    const profileUrl = parseAgentProfile(req);
    if (!profileUrl) {
      send(reply, 400, errorResponse("invalid_request", 'UCP-Agent header with profile="<url>" is required'));
      return null;
    }
    return profileUrl;
  };

  const idempotency = (req: FastifyRequest, reply: FastifyReply): { key: string; record: IdemRecord | null } | null => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key) {
      send(reply, 400, errorResponse("invalid_request", "Idempotency-Key header is required"));
      return null;
    }
    const scoped = `${req.method} ${req.url} ${key}`;
    const record = idem.get(scoped);
    const requestHash = hashBody(req.body);
    if (record) {
      if (record.request_hash !== requestHash) {
        send(reply, 409, errorResponse("idempotency_conflict", "Idempotency-Key reused with a different request body"));
        return null;
      }
      if (record.in_flight) {
        send(reply, 409, errorResponse("idempotency_in_flight", "A request with this Idempotency-Key is still being processed"));
        return null;
      }
      reply.header("Idempotent-Replayed", "true");
      send(reply, record.status, record.body);
      return null;
    }
    const fresh: IdemRecord = { request_hash: requestHash, status: 0, body: null, in_flight: true };
    idem.set(scoped, fresh);
    return { key, record: fresh };
  };

  const finish = (record: IdemRecord | null, status: number, body: unknown): void => {
    if (record) {
      record.status = status;
      record.body = body;
      record.in_flight = false;
    }
  };

  const parseSimulation = (req: FastifyRequest): SimulationFlags => {
    const raw = req.headers["x-fixture-simulation"];
    if (typeof raw !== "string" || !raw) return {};
    try {
      return JSON.parse(raw) as SimulationFlags;
    } catch {
      return {};
    }
  };

  const buildLineItems = (items: UcpLineItem[]): { lines: UcpLineItem[]; messages: UcpMessage[] } => {
    const lines: UcpLineItem[] = [];
    const messages: UcpMessage[] = [];
    items.forEach((li, i) => {
      const c = merchant.catalog.find((x) => x.item_id === li.item.id);
      if (!c) {
        messages.push({ type: "error", code: "item_unavailable", path: `$.line_items[${i}].item.id`, content: `Unknown item ${li.item.id}`, content_type: "plain", severity: "unrecoverable" });
        return;
      }
      if (li.quantity > c.stock) {
        messages.push({ type: "error", code: "out_of_stock", path: `$.line_items[${i}].quantity`, content: `Only ${c.stock} available`, content_type: "plain", severity: "requires_buyer_input" });
      }
      const subtotal = c.unit_price_minor * li.quantity;
      const tax = Math.round((subtotal * merchant.tax_rate_bps) / 10_000);
      lines.push({
        id: li.id ?? `li_${c.item_id}`,
        item: { id: c.item_id, title: c.title, price: c.unit_price_minor },
        quantity: li.quantity,
        totals: [
          { type: "subtotal", amount: subtotal },
          { type: "tax", amount: tax },
          { type: "total", amount: subtotal + tax },
        ],
      });
    });
    return { lines, messages };
  };

  const optionTotals = (stored: StoredCheckout, price: number): UcpTotal[] => {
    const increase = stored.shipping_increase_applied && stored.simulation.shipping_increase?.merchant_id === merchant.id ? stored.simulation.shipping_increase.amount_minor : 0;
    return [
      { type: "subtotal", display_text: "Shipping", amount: price + increase },
      { type: "total", display_text: "Shipping total", amount: price + increase },
    ];
  };

  /** Rebuild the business-authored parts of a fulfillment method from the platform's request. */
  const buildFulfillment = (stored: StoredCheckout, requested: UcpFulfillmentMethod[] | undefined, lineIds: string[], now: Date): UcpFulfillmentMethod[] => {
    const existing = stored.checkout.fulfillment?.methods?.[0];
    const req = requested?.find((m) => m.type === "shipping");
    const destinations = (req?.destinations ?? existing?.destinations ?? []).map((d, i) => ({ ...d, id: d.id ?? `dest_${i + 1}`, type: "shipping_address" as const }));
    const selectedDestination = req?.selected_destination_id ?? destinations[0]?.id ?? null;
    const groupId = existing?.groups?.[0]?.id ?? "package_1";
    const requestedSelected = req?.groups?.find((g) => g.id === groupId || !g.id)?.selected_option_id ?? existing?.groups?.[0]?.selected_option_id ?? null;
    const options = merchant.fulfillment_options.map((o) => {
      const eta = new Date(now.getTime() + o.lead_days * 86_400_000).toISOString();
      return { id: o.option_id, title: o.title, description: { plain: `Arrives in ${o.lead_days} days (fixture lead time)` }, carrier: "Fixture Freight", earliest_fulfillment_time: eta, latest_fulfillment_time: eta, totals: optionTotals(stored, o.price_minor) };
    });
    const valid = options.some((o) => o.id === requestedSelected) ? requestedSelected : null;
    return [
      {
        id: existing?.id ?? "shipping_1",
        type: "shipping",
        line_item_ids: lineIds,
        destinations,
        selected_destination_id: selectedDestination,
        groups: [{ id: groupId, line_item_ids: lineIds, selected_option_id: valid, options }],
      },
    ];
  };

  const recompute = (stored: StoredCheckout): void => {
    const c = stored.checkout;
    const subtotal = c.line_items.reduce((n, l) => n + (l.totals?.find((t) => t.type === "subtotal")?.amount ?? 0), 0);
    const tax = c.line_items.reduce((n, l) => n + (l.totals?.find((t) => t.type === "tax")?.amount ?? 0), 0);
    const method = c.fulfillment?.methods?.[0];
    const group = method?.groups?.[0];
    const option = group?.options?.find((o) => o.id === group.selected_option_id);
    const fulfillment = option ? (option.totals.find((t) => t.type === "total")?.amount ?? 0) : 0;
    c.totals = [
      { type: "subtotal", display_text: "Subtotal", amount: subtotal },
      { type: "fulfillment", display_text: "Shipping", amount: fulfillment },
      { type: "tax", display_text: "Tax", amount: tax },
      { type: "total", display_text: "Total", amount: subtotal + fulfillment + tax },
    ];
    const blocking = (c.messages ?? []).some((m) => m.type === "error");
    if (c.status !== "completed" && c.status !== "canceled") {
      const ready = !!c.buyer?.email && !!method?.selected_destination_id && !!option && c.line_items.length > 0 && !blocking;
      c.status = ready ? "ready_for_complete" : "incomplete";
    }
    c.ucp = { version: UCP_VERSION, capabilities: stored.negotiated, payment_handlers: paymentHandlers };
  };

  const selfCheck = (body: unknown): void => {
    const v = validateUcpCheckoutResponse(body);
    if (!v.ok) throw new Error(`fixture merchant produced an invalid UCP checkout: ${v.errors.join("; ")}`);
  };

  /** Strip request-only members (credential tokens) before echoing payment. */
  const sanitizePayment = (payment: UcpCompleteRequest["payment"] | undefined): UcpCheckout["payment"] | undefined => {
    if (!payment?.instruments) return payment;
    return {
      instruments: payment.instruments.map((i) => {
        const { credential, ...rest } = i;
        return credential ? { ...rest, credential: { type: credential.type } } : rest;
      }),
    };
  };

  // ---- profile ---------------------------------------------------------------------------
  app.get("/.well-known/ucp", async () => profile);

  // ---- create ----------------------------------------------------------------------------
  app.post("/ucp/shopping/checkout-sessions", async (req, reply) => {
    const profileUrl = authorize(req, reply);
    if (!profileUrl) return;
    const idem = idempotency(req, reply);
    if (!idem) return;
    const v = validateUcpCheckoutRequest("create", req.body);
    if (!v.ok) {
      const e = errorResponse("invalid_request", v.errors.join("; "));
      finish(idem.record, 400, e);
      return send(reply, 400, e);
    }
    const body = req.body as UcpCheckoutRequest;
    const now = clock();
    const { capabilities, warning } = await negotiate(profileUrl);
    const { lines, messages } = buildLineItems(body.line_items);
    if (warning) messages.push(warning);
    const id = nextId("chk");
    const stored: StoredCheckout = {
      checkout: {
        ucp: { version: UCP_VERSION },
        id,
        status: "incomplete",
        currency: "USD",
        line_items: lines,
        totals: [],
        messages,
        links: [
          { type: "terms_of_service", url: `${merchant.base_url}/fixture/terms` },
          { type: "return_policy", url: `${merchant.base_url}/fixture/returns` },
        ],
        expires_at: new Date(now.getTime() + 6 * 3_600_000).toISOString(),
      },
      simulation: parseSimulation(req),
      reads: 0,
      shipping_increase_applied: false,
      drop_used: false,
      payment_events: [],
      negotiated: capabilities,
    };
    if (body.buyer) stored.checkout.buyer = body.buyer;
    if (capabilities[UCP_FULFILLMENT_CAPABILITY]) {
      stored.checkout.fulfillment = { methods: buildFulfillment(stored, body.fulfillment?.methods, lines.map((l) => l.id!), now), available_methods: [{ type: "shipping", line_item_ids: lines.map((l) => l.id!), fulfillable_on: "now" }] };
    }
    recompute(stored);
    checkouts.set(id, stored);
    selfCheck(stored.checkout);
    finish(idem.record, 201, stored.checkout);
    return send(reply, 201, stored.checkout);
  });

  // ---- read ------------------------------------------------------------------------------
  app.get("/ucp/shopping/checkout-sessions/:id", async (req, reply) => {
    if (!authorize(req, reply)) return;
    const stored = checkouts.get((req.params as { id: string }).id);
    if (!stored) return send(reply, 404, errorResponse("not_found", "Checkout session not found"));
    stored.reads += 1;
    // Injected failure: shipping is re-priced after the first read (labelled fixture behaviour).
    if (stored.simulation.shipping_increase?.merchant_id === merchant.id && stored.reads >= 2 && !stored.shipping_increase_applied && stored.checkout.status !== "completed") {
      stored.shipping_increase_applied = true;
      const method = stored.checkout.fulfillment?.methods?.[0];
      for (const g of method?.groups ?? []) {
        for (const o of g.options ?? []) {
          const fixture = merchant.fulfillment_options.find((f) => f.option_id === o.id);
          if (fixture) o.totals = optionTotals(stored, fixture.price_minor);
        }
      }
      stored.checkout.messages = [...(stored.checkout.messages ?? []), { type: "info", code: "fulfillment_repriced", content: `Shipping surcharge of ${stored.simulation.shipping_increase.amount_minor} applied (fixture: shipping_increase)`, content_type: "plain" }];
      recompute(stored);
    }
    selfCheck(stored.checkout);
    return send(reply, 200, stored.checkout);
  });

  // ---- update (full replacement of platform-authored fields) -----------------------------
  app.put("/ucp/shopping/checkout-sessions/:id", async (req, reply) => {
    if (!authorize(req, reply)) return;
    const idem = idempotency(req, reply);
    if (!idem) return;
    const stored = checkouts.get((req.params as { id: string }).id);
    if (!stored) {
      const e = errorResponse("not_found", "Checkout session not found");
      finish(idem.record, 404, e);
      return send(reply, 404, e);
    }
    const v = validateUcpCheckoutRequest("update", req.body);
    if (!v.ok) {
      const e = errorResponse("invalid_request", v.errors.join("; "));
      finish(idem.record, 400, e);
      return send(reply, 400, e);
    }
    if (stored.checkout.status === "completed" || stored.checkout.status === "canceled") {
      const e = errorResponse("invalid_state", `Checkout is ${stored.checkout.status}`);
      finish(idem.record, 409, e);
      return send(reply, 409, e);
    }
    const body = req.body as UcpCheckoutRequest;
    const now = clock();
    const { lines, messages } = buildLineItems(body.line_items);
    const keep = (stored.checkout.messages ?? []).filter((m) => m.type !== "error");
    stored.checkout.line_items = lines;
    stored.checkout.messages = [...keep, ...messages];
    if (body.buyer) stored.checkout.buyer = body.buyer;
    if (stored.negotiated[UCP_FULFILLMENT_CAPABILITY]) {
      stored.checkout.fulfillment = { methods: buildFulfillment(stored, body.fulfillment?.methods, lines.map((l) => l.id!), now), available_methods: [{ type: "shipping", line_item_ids: lines.map((l) => l.id!), fulfillable_on: "now" }] };
    }
    recompute(stored);
    selfCheck(stored.checkout);
    finish(idem.record, 200, stored.checkout);
    return send(reply, 200, stored.checkout);
  });

  // ---- complete --------------------------------------------------------------------------
  app.post("/ucp/shopping/checkout-sessions/:id/complete", async (req, reply) => {
    if (!authorize(req, reply)) return;
    const idem = idempotency(req, reply);
    if (!idem) return;
    const stored = checkouts.get((req.params as { id: string }).id);
    if (!stored) {
      const e = errorResponse("not_found", "Checkout session not found");
      finish(idem.record, 404, e);
      return send(reply, 404, e);
    }
    const v = validateUcpCheckoutRequest("complete", req.body);
    if (!v.ok) {
      const e = errorResponse("invalid_request", v.errors.join("; "));
      finish(idem.record, 400, e);
      return send(reply, 400, e);
    }
    const body = req.body as UcpCompleteRequest;
    const c = stored.checkout;
    if (c.status === "completed" && c.order) {
      // Different idempotency key against an already-completed checkout: never charge twice.
      finish(idem.record, 200, c);
      return send(reply, 200, c);
    }
    if (c.status !== "ready_for_complete") {
      const e = errorResponse("invalid_state", `Checkout status is ${c.status}`);
      finish(idem.record, 409, e);
      return send(reply, 409, e);
    }
    const instrument = body.payment.instruments?.find((i) => i.selected) ?? body.payment.instruments?.[0];
    const token = instrument?.credential?.token;
    if (!instrument || instrument.handler_id !== handler.id || typeof token !== "string") {
      c.messages = [...(c.messages ?? []), { type: "error", code: "payment_failed", path: "$.payment.instruments", content: `Instrument must reference handler ${handler.id} with a token credential`, content_type: "plain", severity: "requires_buyer_input" }];
      recompute(stored);
      selfCheck(c);
      finish(idem.record, 200, c);
      return send(reply, 200, c);
    }
    const now = clock().toISOString();
    const fingerprint = createHash("sha256").update(token).digest("hex").slice(0, 12);
    c.payment = sanitizePayment(body.payment);
    stored.payment_events.push({ at: now, event: "payment_authorized", token_fingerprint: fingerprint });

    if (stored.simulation.payment_ok_order_rejected === merchant.id) {
      stored.payment_events.push({ at: now, event: "payment_voided", token_fingerprint: fingerprint });
      c.status = "canceled";
      c.messages = [...(c.messages ?? []), { type: "error", code: "item_unavailable", content: "Payment was authorised and voided; the order was rejected by fulfilment (fixture: payment_ok_order_rejected)", content_type: "plain", severity: "unrecoverable" }];
      recompute(stored);
      selfCheck(c);
      finish(idem.record, 200, c);
      return send(reply, 200, c);
    }

    stored.payment_events.push({ at: now, event: "payment_captured", token_fingerprint: fingerprint });
    const orderId = nextId("ord");
    orders.set(orderId, { order_id: orderId, checkout_id: c.id, created_at: now });
    c.status = "completed";
    c.order = { id: orderId, label: `Order ${orderId}`, permalink_url: `${merchant.base_url}/fixture/orders/${orderId}` };
    recompute(stored);
    selfCheck(c);
    finish(idem.record, 200, c);

    if (stored.simulation.drop_completion_response === merchant.id && !stored.drop_used) {
      // Injected failure: order created and payment captured, but the response
      // never reaches the platform. A retry with the same key replays.
      stored.drop_used = true;
      app.log.warn({ checkout: c.id }, "fixture: dropping completion response");
      reply.hijack();
      req.raw.socket.destroy();
      return;
    }
    return send(reply, 200, c);
  });

  // ---- cancel ----------------------------------------------------------------------------
  app.post("/ucp/shopping/checkout-sessions/:id/cancel", async (req, reply) => {
    if (!authorize(req, reply)) return;
    const idem = idempotency(req, reply);
    if (!idem) return;
    const stored = checkouts.get((req.params as { id: string }).id);
    if (!stored) {
      const e = errorResponse("not_found", "Checkout session not found");
      finish(idem.record, 404, e);
      return send(reply, 404, e);
    }
    if (stored.checkout.status === "completed") {
      const e = errorResponse("invalid_state", "Completed checkouts cannot be canceled");
      finish(idem.record, 409, e);
      return send(reply, 409, e);
    }
    stored.checkout.status = "canceled";
    recompute(stored);
    selfCheck(stored.checkout);
    finish(idem.record, 200, stored.checkout);
    return send(reply, 200, stored.checkout);
  });

  // ---- fixture introspection (not part of UCP; used by tests to prove single purchase) -----
  app.get("/fixture/orders", async () => ({ orders: [...orders.values()] }));
  app.get("/fixture/sessions/:id/payment-events", async (req, reply) => {
    const stored = checkouts.get((req.params as { id: string }).id);
    if (!stored) return send(reply, 404, { error: "not_found" });
    return { payment_events: stored.payment_events };
  });
  app.get("/healthz", async () => ({ ok: true, merchant: merchant.id, protocol: "ucp", version: UCP_VERSION }));

  return app;
}
