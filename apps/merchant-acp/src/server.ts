/**
 * Fixture merchant implementing the Agentic Commerce Protocol — Agentic
 * Checkout, release 2026-01-16 (see packages/protocol-contracts/vendor/acp).
 *
 * Behaviour that matters for the procurement agent:
 *   - `Authorization: Bearer <api key>` and `API-Version: 2026-01-16` required
 *   - `Idempotency-Key` required on every POST; identical replays return the
 *     stored response with `Idempotent-Replayed: true`; same key + different
 *     body → 422 request_not_idempotent; same key still in flight → 409
 *   - every emitted session is validated against the vendored JSON schema
 *   - failure injection is explicit: the agent passes `X-Fixture-Simulation`
 *     (JSON) at session creation and the flags are stored on the session
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { loadMerchants, type MerchantFixture } from "@procurement/domain";
import type { SimulationFlags } from "@procurement/domain";
import {
  ACP_API_VERSION,
  validateAcp,
  type AcpCheckoutSession,
  type AcpCheckoutSessionCompleteRequest,
  type AcpCheckoutSessionCreateRequest,
  type AcpCheckoutSessionUpdateRequest,
  type AcpCheckoutSessionWithOrder,
  type AcpError,
  type AcpFulfillmentOptionShipping,
  type AcpLineItem,
  type AcpTotal,
} from "@procurement/protocol-contracts";

interface StoredSession {
  session: AcpCheckoutSession;
  simulation: SimulationFlags;
  reads: number;
  shipping_increase_applied: boolean;
  drop_used: boolean;
  payment_events: Array<{ at: string; event: string; token_fingerprint: string }>;
}

interface IdemRecord {
  request_hash: string;
  status: number;
  body: unknown;
  in_flight: boolean;
}

export interface MerchantAcpOptions {
  merchant?: MerchantFixture;
  apiKey?: string;
  clock?: () => Date;
  logger?: boolean;
}

function err(type: AcpError["type"], code: string, message: string, param?: string): AcpError {
  return param ? { type, code, message, param } : { type, code, message };
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

let seq = 0;
const nextId = (p: string): string => `${p}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function buildMerchantAcp(opts: MerchantAcpOptions = {}): FastifyInstance {
  const merchant = opts.merchant ?? loadMerchants().find((m) => m.protocol === "acp")!;
  const apiKey = opts.apiKey ?? process.env[merchant.api_key_env] ?? merchant.api_key_default;
  const clock = opts.clock ?? (() => new Date());
  const sessions = new Map<string, StoredSession>();
  const orders = new Map<string, { order_id: string; session_id: string; created_at: string }>();
  const idem = new Map<string, IdemRecord>();

  const app = Fastify({ logger: opts.logger ?? false });

  // ---- helpers ---------------------------------------------------------------------------
  const send = (reply: FastifyReply, status: number, body: unknown): FastifyReply => reply.code(status).header("content-type", "application/json").send(body);

  const authorize = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${apiKey}`) {
      send(reply, 401, err("invalid_request", "unauthorized", "Missing or invalid bearer token"));
      return false;
    }
    const version = req.headers["api-version"];
    if (version !== ACP_API_VERSION) {
      send(reply, 400, err("invalid_request", "unsupported_api_version", `API-Version must be ${ACP_API_VERSION}`, "$.headers.API-Version"));
      return false;
    }
    return true;
  };

  /** Returns a stored idempotent response (already sent) or a record to fill. */
  const idempotency = (req: FastifyRequest, reply: FastifyReply): { key: string; record: IdemRecord | null } | null => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) {
      send(reply, 400, err("invalid_request", "idempotency_key_required", "Idempotency-Key header is required on POST", "$.headers.Idempotency-Key"));
      return null;
    }
    const scoped = `${req.method} ${req.url} ${key}`;
    const record = idem.get(scoped);
    const requestHash = hashBody(req.body);
    if (record) {
      if (record.request_hash !== requestHash) {
        send(reply, 422, err("request_not_idempotent", "idempotency_conflict", "Idempotency-Key was already used with a different request body"));
        return null;
      }
      if (record.in_flight) {
        send(reply, 409, err("processing_error", "idempotency_in_flight", "A request with this Idempotency-Key is still being processed"));
        return null;
      }
      reply.header("Idempotent-Replayed", "true").header("Idempotency-Key", key);
      send(reply, record.status, record.body);
      return null;
    }
    const fresh: IdemRecord = { request_hash: requestHash, status: 0, body: null, in_flight: true };
    idem.set(scoped, fresh);
    reply.header("Idempotency-Key", key);
    return { key, record: fresh };
  };

  const finish = (record: IdemRecord | null, status: number, body: unknown): void => {
    if (record) {
      record.status = status;
      record.body = body;
      record.in_flight = false;
    }
  };

  const catalogItem = (id: string) => merchant.catalog.find((c) => c.item_id === id);

  const fulfillmentOptions = (now: Date, stored: StoredSession | null): AcpFulfillmentOptionShipping[] =>
    merchant.fulfillment_options.map((o) => {
      const increase = stored?.shipping_increase_applied && stored.simulation.shipping_increase?.merchant_id === merchant.id ? stored.simulation.shipping_increase.amount_minor : 0;
      const price = o.price_minor + increase;
      const previous = stored?.session.fulfillment_options.find((p): p is AcpFulfillmentOptionShipping => p.type === "shipping" && p.id === o.option_id);
      const eta = previous?.latest_delivery_time ? new Date(previous.latest_delivery_time) : new Date(now.getTime() + o.lead_days * 86_400_000);
      return {
        type: "shipping",
        id: o.option_id,
        title: o.title,
        description: `${o.lead_days}-day lead time (fixture)`,
        carrier: "Fixture Freight",
        earliest_delivery_time: eta.toISOString(),
        latest_delivery_time: eta.toISOString(),
        totals: [
          { type: "subtotal", display_text: "Shipping", amount: price },
          { type: "tax", display_text: "Tax", amount: 0 },
          { type: "total", display_text: "Total", amount: price },
        ],
      };
    });

  const recompute = (stored: StoredSession, now: Date): void => {
    const s = stored.session;
    s.fulfillment_options = fulfillmentOptions(now, stored);
    // Keep option timestamps stable per session after first computation
    const itemsBase = s.line_items.reduce((n, l) => n + l.base_amount, 0);
    const subtotal = s.line_items.reduce((n, l) => n + l.subtotal, 0);
    const tax = s.line_items.reduce((n, l) => n + l.tax, 0);
    const selected = s.selected_fulfillment_options?.[0]?.shipping?.option_id;
    const option = s.fulfillment_options.find((o) => o.id === selected);
    const fulfillment = option ? (option.totals.find((t) => t.type === "total")?.amount ?? 0) : 0;
    const totals: AcpTotal[] = [
      { type: "items_base_amount", display_text: "Items", amount: itemsBase },
      { type: "subtotal", display_text: "Subtotal", amount: subtotal },
      { type: "fulfillment", display_text: "Shipping", amount: fulfillment },
      { type: "tax", display_text: "Tax", amount: tax },
      { type: "total", display_text: "Total", amount: subtotal + fulfillment + tax },
    ];
    s.totals = totals;
    if (s.status !== "completed" && s.status !== "canceled") {
      const ready = !!s.fulfillment_details?.address && !!option && s.line_items.length > 0;
      s.status = ready ? "ready_for_payment" : "not_ready_for_payment";
    }
  };

  const buildLineItems = (items: AcpCheckoutSessionCreateRequest["items"], reply: FastifyReply, record: IdemRecord | null): AcpLineItem[] | null => {
    const lines: AcpLineItem[] = [];
    for (const [i, it] of items.entries()) {
      const c = catalogItem(it.id);
      if (!c) {
        const e = err("invalid_request", "unknown_item", `Unknown item ${it.id}`, `$.items[${i}].id`);
        finish(record, 404, e);
        send(reply, 404, e);
        return null;
      }
      if (it.quantity > c.stock) {
        const e = err("invalid_request", "out_of_stock", `Only ${c.stock} of ${it.id} available`, `$.items[${i}].quantity`);
        finish(record, 400, e);
        send(reply, 400, e);
        return null;
      }
      const base = c.unit_price_minor * it.quantity;
      const tax = Math.round((base * merchant.tax_rate_bps) / 10_000);
      lines.push({ id: `li_${c.item_id}`, item: { id: c.item_id, quantity: it.quantity }, base_amount: base, discount: 0, subtotal: base, tax, total: base + tax, name: c.title, unit_amount: c.unit_price_minor });
    }
    return lines;
  };

  const selfCheck = (def: "CheckoutSession" | "CheckoutSessionWithOrder", body: unknown): void => {
    const v = validateAcp(def, body);
    if (!v.ok) throw new Error(`fixture merchant produced an invalid ${def}: ${v.errors.join("; ")}`);
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

  // ---- discovery (fixture-specific; ACP itself has no capability document) -----------------
  app.get("/.well-known/acp-fixture-capabilities", async () => ({
    protocol: "acp",
    api_version: ACP_API_VERSION,
    merchant_id: merchant.id,
    endpoints: { checkout_sessions: `${merchant.base_url}/checkout_sessions` },
    payment_providers: [{ provider: merchant.payment_provider ?? "stripe", supported_payment_methods: [{ type: "card", supported_card_networks: ["visa", "mastercard", "amex"] }] }],
    note: "Fixture-only document. The ACP 2026-01-16 specification defines no discovery endpoint; capabilities are conveyed out of band.",
  }));

  // ---- create ----------------------------------------------------------------------------
  app.post("/checkout_sessions", async (req, reply) => {
    if (!authorize(req, reply)) return;
    const idem = idempotency(req, reply);
    if (!idem) return;
    const v = validateAcp("CheckoutSessionCreateRequest", req.body);
    if (!v.ok) {
      const e = err("invalid_request", "schema_violation", v.errors.join("; "));
      finish(idem.record, 400, e);
      return send(reply, 400, e);
    }
    const body = req.body as AcpCheckoutSessionCreateRequest;
    const now = clock();
    const lines = buildLineItems(body.items, reply, idem.record);
    if (!lines) return;
    const id = nextId("cs");
    const session: AcpCheckoutSession = {
      id,
      status: "not_ready_for_payment",
      currency: "usd",
      line_items: lines,
      fulfillment_options: [],
      totals: [],
      messages: [],
      links: [
        { type: "terms_of_use", url: `${merchant.base_url}/fixture/terms` },
        { type: "return_policy", url: `${merchant.base_url}/fixture/returns` },
      ],
      payment_provider: { provider: "stripe", merchant_id: `acct_fixture_${merchant.id}`, supported_payment_methods: [{ type: "card", supported_card_networks: ["visa", "mastercard", "amex"] }] },
    };
    if (body.buyer) session.buyer = body.buyer;
    if (body.fulfillment_details) session.fulfillment_details = body.fulfillment_details;
    const stored: StoredSession = { session, simulation: parseSimulation(req), reads: 0, shipping_increase_applied: false, drop_used: false, payment_events: [] };
    recompute(stored, now);
    // Preselect the merchant's default shipping option when an address is present
    if (session.fulfillment_details?.address && session.fulfillment_options[0]) {
      session.selected_fulfillment_options = [{ type: "shipping", shipping: { option_id: session.fulfillment_options[0].id, item_ids: session.line_items.map((l) => l.id) } }];
      recompute(stored, now);
    }
    sessions.set(id, stored);
    selfCheck("CheckoutSession", session);
    finish(idem.record, 201, session);
    return send(reply, 201, session);
  });

  // ---- retrieve --------------------------------------------------------------------------
  app.get("/checkout_sessions/:id", async (req, reply) => {
    if (!authorize(req, reply)) return;
    const stored = sessions.get((req.params as { id: string }).id);
    if (!stored) return send(reply, 404, err("invalid_request", "not_found", "Checkout session not found"));
    stored.reads += 1;
    // Injected failure: the merchant re-prices shipping after the first read (labelled fixture behaviour).
    if (stored.simulation.shipping_increase?.merchant_id === merchant.id && stored.reads >= 2 && !stored.shipping_increase_applied && stored.session.status !== "completed") {
      stored.shipping_increase_applied = true;
      recompute(stored, clock());
      stored.session.messages.push({ type: "info", content_type: "plain", content: `Shipping surcharge of ${stored.simulation.shipping_increase.amount_minor} applied (fixture: shipping_increase)` });
    }
    selfCheck("CheckoutSession", stored.session);
    return send(reply, 200, stored.session);
  });

  // ---- update ----------------------------------------------------------------------------
  app.post("/checkout_sessions/:id", async (req, reply) => {
    if (!authorize(req, reply)) return;
    const idem = idempotency(req, reply);
    if (!idem) return;
    const stored = sessions.get((req.params as { id: string }).id);
    if (!stored) {
      const e = err("invalid_request", "not_found", "Checkout session not found");
      finish(idem.record, 404, e);
      return send(reply, 404, e);
    }
    const v = validateAcp("CheckoutSessionUpdateRequest", req.body);
    if (!v.ok) {
      const e = err("invalid_request", "schema_violation", v.errors.join("; "));
      finish(idem.record, 400, e);
      return send(reply, 400, e);
    }
    if (stored.session.status === "completed" || stored.session.status === "canceled") {
      const e = err("invalid_request", "session_closed", `Session is ${stored.session.status}`);
      finish(idem.record, 409, e);
      return send(reply, 409, e);
    }
    const body = req.body as AcpCheckoutSessionUpdateRequest;
    if (body.items) {
      const lines = buildLineItems(body.items, reply, idem.record);
      if (!lines) return;
      stored.session.line_items = lines;
    }
    if (body.buyer) stored.session.buyer = body.buyer;
    if (body.fulfillment_details) stored.session.fulfillment_details = body.fulfillment_details;
    if (body.selected_fulfillment_options) stored.session.selected_fulfillment_options = body.selected_fulfillment_options;
    recompute(stored, clock());
    selfCheck("CheckoutSession", stored.session);
    finish(idem.record, 200, stored.session);
    return send(reply, 200, stored.session);
  });

  // ---- complete --------------------------------------------------------------------------
  app.post("/checkout_sessions/:id/complete", async (req, reply) => {
    if (!authorize(req, reply)) return;
    const idem = idempotency(req, reply);
    if (!idem) return;
    const stored = sessions.get((req.params as { id: string }).id);
    if (!stored) {
      const e = err("invalid_request", "not_found", "Checkout session not found");
      finish(idem.record, 404, e);
      return send(reply, 404, e);
    }
    const v = validateAcp("CheckoutSessionCompleteRequest", req.body);
    if (!v.ok) {
      const e = err("invalid_request", "schema_violation", v.errors.join("; "));
      finish(idem.record, 400, e);
      return send(reply, 400, e);
    }
    const body = req.body as AcpCheckoutSessionCompleteRequest;
    const s = stored.session;
    if (s.status === "completed" && s.order) {
      // A different idempotency key for an already-completed session: never charge twice.
      finish(idem.record, 200, s);
      return send(reply, 200, s);
    }
    if (s.status !== "ready_for_payment") {
      const e = err("invalid_request", "not_ready_for_payment", `Session status is ${s.status}`);
      finish(idem.record, 409, e);
      return send(reply, 409, e);
    }
    const now = clock().toISOString();
    const fingerprint = createHash("sha256").update(body.payment_data.token).digest("hex").slice(0, 12);
    if (body.buyer) s.buyer = body.buyer;
    stored.payment_events.push({ at: now, event: "payment_authorized", token_fingerprint: fingerprint });

    if (stored.simulation.payment_ok_order_rejected === merchant.id) {
      stored.payment_events.push({ at: now, event: "payment_voided", token_fingerprint: fingerprint });
      s.status = "canceled";
      s.messages.push({ type: "error", code: "out_of_stock", content_type: "plain", content: "Payment was authorised and voided; the order was rejected by fulfilment (fixture: payment_ok_order_rejected)" });
      selfCheck("CheckoutSession", s);
      finish(idem.record, 200, s);
      return send(reply, 200, s);
    }

    stored.payment_events.push({ at: now, event: "payment_captured", token_fingerprint: fingerprint });
    const orderId = nextId("ord");
    orders.set(orderId, { order_id: orderId, session_id: s.id, created_at: now });
    const completed: AcpCheckoutSessionWithOrder = { ...s, status: "completed", order: { id: orderId, checkout_session_id: s.id, permalink_url: `${merchant.base_url}/fixture/orders/${orderId}` } };
    stored.session = completed;
    selfCheck("CheckoutSessionWithOrder", completed);
    finish(idem.record, 200, completed);

    if (stored.simulation.drop_completion_response === merchant.id && !stored.drop_used) {
      // Injected failure: the order exists, the payment is captured, but the
      // response never reaches the caller. A retry with the same key replays.
      stored.drop_used = true;
      app.log.warn({ session: s.id }, "fixture: dropping completion response");
      reply.hijack();
      req.raw.socket.destroy();
      return;
    }
    return send(reply, 200, completed);
  });

  // ---- cancel ----------------------------------------------------------------------------
  app.post("/checkout_sessions/:id/cancel", async (req, reply) => {
    if (!authorize(req, reply)) return;
    const idem = idempotency(req, reply);
    if (!idem) return;
    const stored = sessions.get((req.params as { id: string }).id);
    if (!stored) {
      const e = err("invalid_request", "not_found", "Checkout session not found");
      finish(idem.record, 404, e);
      return send(reply, 404, e);
    }
    if (stored.session.status === "completed") {
      const e = err("invalid_request", "already_completed", "Completed sessions cannot be canceled");
      finish(idem.record, 405, e);
      return send(reply, 405, e);
    }
    stored.session.status = "canceled";
    selfCheck("CheckoutSession", stored.session);
    finish(idem.record, 200, stored.session);
    return send(reply, 200, stored.session);
  });

  // ---- fixture introspection (not part of ACP; used by tests to prove single purchase) -----
  app.get("/fixture/orders", async () => ({ orders: [...orders.values()] }));
  app.get("/fixture/sessions/:id/payment-events", async (req, reply) => {
    const stored = sessions.get((req.params as { id: string }).id);
    if (!stored) return send(reply, 404, { error: "not_found" });
    return { payment_events: stored.payment_events };
  });
  app.get("/healthz", async () => ({ ok: true, merchant: merchant.id, protocol: "acp", api_version: ACP_API_VERSION }));

  return app;
}
