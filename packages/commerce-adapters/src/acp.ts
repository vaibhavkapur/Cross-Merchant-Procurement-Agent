/**
 * ACP adapter — Agentic Checkout release 2026-01-16.
 *
 * Translates the narrow `CommerceAdapter` interface onto the merchant's native
 * ACP REST surface. Every outbound request body and inbound response is
 * validated against the vendored 2026-01-16 JSON schema before it is trusted.
 */
import {
  ACP_API_VERSION,
  validateAcp,
  type AcpCheckoutSession,
  type AcpCheckoutSessionCompleteRequest,
  type AcpCheckoutSessionCreateRequest,
  type AcpCheckoutSessionUpdateRequest,
  type AcpError,
  type AcpFulfillmentOptionShipping,
} from "@procurement/protocol-contracts";
import type {
  CapabilitySnapshot,
  CheckoutInput,
  CheckoutView,
  CommerceAdapter,
  CompletionInput,
  CompletionOutcome,
  Destination,
  Merchant,
  NormalizedCheckoutStatus,
  ReconciliationResult,
} from "@procurement/domain";
import { DomainError } from "@procurement/domain";
import { ProtocolHttp, TransportError, resolvePaymentToken } from "./http.ts";

export interface AcpAdapterOptions {
  merchants: Merchant[];
  apiKeyFor: (merchant: Merchant) => string;
  http: ProtocolHttp;
  clock?: () => Date;
}

const STATUS_MAP: Record<AcpCheckoutSession["status"], NormalizedCheckoutStatus> = {
  not_ready_for_payment: "incomplete",
  ready_for_payment: "ready",
  in_progress: "completing",
  completed: "completed",
  canceled: "canceled",
  authentication_required: "blocked",
};

function splitName(name: string): { first_name: string; last_name: string } {
  const parts = name.trim().split(/\s+/);
  return { first_name: parts[0] ?? "Buyer", last_name: parts.slice(1).join(" ") || "Account" };
}

function toAddress(d: Destination) {
  return {
    name: d.contact_name,
    line_one: d.line_one,
    ...(d.line_two ? { line_two: d.line_two } : {}),
    city: d.locality,
    state: d.region,
    country: d.country,
    postal_code: d.postal_code,
  };
}

export class AcpAdapter implements CommerceAdapter {
  readonly protocol = "acp" as const;
  private readonly merchants: Merchant[];
  private readonly apiKeyFor: (merchant: Merchant) => string;
  private readonly http: ProtocolHttp;
  private readonly clock: () => Date;

  constructor(opts: AcpAdapterOptions) {
    this.merchants = opts.merchants.filter((m) => m.protocol === "acp");
    this.apiKeyFor = opts.apiKeyFor;
    this.http = opts.http;
    this.clock = opts.clock ?? (() => new Date());
  }

  private merchant(id: string): Merchant {
    const m = this.merchants.find((x) => x.id === id);
    if (!m) throw new DomainError("merchant_not_found", `ACP adapter has no merchant ${id}`, 404);
    return m;
  }

  private headers(m: Merchant, idempotencyKey?: string, traceId?: string): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKeyFor(m)}`,
      "api-version": ACP_API_VERSION,
      "user-agent": "cross-merchant-procurement-agent/0.1 (acp)",
      ...(traceId ? { "request-id": traceId } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    };
  }

  private call(m: Merchant, op: string, method: "GET" | "POST", path: string, ctx: { trace_id: string; procurement_request_id: string | null }, body?: unknown, idempotencyKey?: string, timeoutMs?: number) {
    return this.http.call({
      protocol: "acp",
      version: ACP_API_VERSION,
      operation: op,
      merchant_id: m.id,
      procurement_request_id: ctx.procurement_request_id,
      trace_id: ctx.trace_id,
      method,
      url: `${m.base_url}${path}`,
      headers: this.headers(m, idempotencyKey, ctx.trace_id),
      body,
      timeoutMs,
    });
  }

  private parseSession(body: unknown, def: "CheckoutSession" | "CheckoutSessionWithOrder" = "CheckoutSession"): AcpCheckoutSession {
    const v = validateAcp(def, body);
    if (!v.ok) throw new DomainError("native_schema_violation", `ACP ${def} failed schema validation: ${v.errors.slice(0, 5).join("; ")}`, 502, v.errors);
    return body as AcpCheckoutSession;
  }

  private parseError(body: unknown): AcpError | null {
    return validateAcp("Error", body).ok ? (body as AcpError) : null;
  }

  toView(m: Merchant, s: AcpCheckoutSession): CheckoutView {
    const total = (type: string) => s.totals.find((t) => t.type === type)?.amount ?? 0;
    const selectedId = s.selected_fulfillment_options?.[0]?.shipping?.option_id ?? null;
    const option = s.fulfillment_options.find((o): o is AcpFulfillmentOptionShipping => o.type === "shipping" && o.id === selectedId);
    const terms: Record<string, string> = {};
    for (const l of s.links) terms[`link:${l.type}`] = l.url;
    if (option) terms["fulfillment_option_title"] = option.title;
    if (option?.carrier) terms["carrier"] = option.carrier;
    if (s.order) {
      terms["order_permalink"] = s.order.permalink_url;
    }
    return {
      protocol: "acp",
      protocol_version: ACP_API_VERSION,
      merchant_id: m.id,
      native_checkout_id: s.id,
      native_status: s.status,
      normalized_status: STATUS_MAP[s.status],
      currency: s.currency.toUpperCase(),
      line_items: s.line_items.map((l) => ({ native_line_id: l.id, merchant_item_id: l.item.id, title: l.name ?? l.item.id, quantity: l.item.quantity, unit_minor: l.unit_amount ?? null, total_minor: l.total })),
      totals: { subtotal_minor: total("subtotal"), tax_minor: total("tax"), shipping_minor: total("fulfillment"), fees_minor: total("fee"), total_minor: total("total") },
      delivery_promise: option?.latest_delivery_time ?? option?.earliest_delivery_time ?? null,
      fulfillment_option: selectedId,
      payment_handler: s.payment_provider ? { id: s.payment_provider.merchant_id, type: s.payment_provider.provider } : null,
      native_order_id: s.order?.id ?? null,
      messages: s.messages.map((msg) => ({ type: msg.type, code: msg.type === "error" ? msg.code : null, content: msg.content })),
      terms,
      native: s,
    };
  }

  async discover(merchantId: string, traceId: string): Promise<CapabilitySnapshot> {
    const m = this.merchant(merchantId);
    // ACP 2026-01-16 defines no discovery document; the fixture merchant publishes
    // one so that capability checks are explicit rather than assumed.
    const res = await this.http.call({ protocol: "acp", version: ACP_API_VERSION, operation: "discover", merchant_id: m.id, procurement_request_id: null, trace_id: traceId, method: "GET", url: m.discovery_url, headers: {} });
    const doc = (res.status === 200 && res.body && typeof res.body === "object" ? res.body : {}) as { api_version?: string; payment_providers?: Array<{ provider: string }>; endpoints?: { checkout_sessions?: string } };
    const versionOk = doc.api_version === ACP_API_VERSION;
    return {
      merchant_id: m.id,
      protocol: "acp",
      protocol_version: doc.api_version ?? "unknown",
      endpoint: doc.endpoints?.checkout_sessions ?? `${m.base_url}/checkout_sessions`,
      capabilities: versionOk ? ["checkout_sessions.create", "checkout_sessions.update", "checkout_sessions.get", "checkout_sessions.complete", "checkout_sessions.cancel"] : [],
      payment_handlers: (doc.payment_providers ?? []).map((p) => p.provider),
      supports_checkout: versionOk,
      discovered_at: this.clock().toISOString(),
      native: res.body,
    };
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutView> {
    const m = this.merchant(input.merchant_id);
    const ctx = { trace_id: input.trace_id, procurement_request_id: input.procurement_request_id };
    const create: AcpCheckoutSessionCreateRequest = {
      items: input.quote.items.map((i) => ({ id: i.merchant_item_id, quantity: i.quantity })),
      fulfillment_details: { name: input.destination.contact_name, phone_number: input.destination.contact_phone, email: input.destination.contact_email, address: toAddress(input.destination) },
    };
    const cv = validateAcp("CheckoutSessionCreateRequest", create);
    if (!cv.ok) throw new DomainError("native_schema_violation", `outbound ACP create request invalid: ${cv.errors.join("; ")}`, 500);
    const headers: Record<string, string> = Object.keys(input.simulation).length ? { "x-fixture-simulation": JSON.stringify(input.simulation) } : {};
    const res = await this.http.call({
      protocol: "acp",
      version: ACP_API_VERSION,
      operation: "checkout_sessions.create",
      merchant_id: m.id,
      procurement_request_id: ctx.procurement_request_id,
      trace_id: ctx.trace_id,
      method: "POST",
      url: `${m.base_url}/checkout_sessions`,
      headers: { ...this.headers(m, `${input.idempotency_key}:create`, ctx.trace_id), ...headers },
      body: create,
    });
    if (res.status !== 201) throw this.failure("create", res.status, res.body);
    let session = this.parseSession(res.body);
    if (session.currency.toUpperCase() !== input.currency.toUpperCase()) {
      throw new DomainError("currency_mismatch", `Merchant checkout currency ${session.currency} differs from ${input.currency}`, 422);
    }
    // Select the fulfillment option the supplier quoted (delivery.method).
    const wanted = input.quote.artifact.delivery.method;
    const current = session.selected_fulfillment_options?.[0]?.shipping?.option_id;
    if (wanted && current !== wanted && session.fulfillment_options.some((o) => o.id === wanted)) {
      const update: AcpCheckoutSessionUpdateRequest = { selected_fulfillment_options: [{ type: "shipping", shipping: { option_id: wanted, item_ids: session.line_items.map((l) => l.id) } }] };
      const uv = validateAcp("CheckoutSessionUpdateRequest", update);
      if (!uv.ok) throw new DomainError("native_schema_violation", `outbound ACP update request invalid: ${uv.errors.join("; ")}`, 500);
      const ures = await this.call(m, "checkout_sessions.update", "POST", `/checkout_sessions/${session.id}`, ctx, update, `${input.idempotency_key}:update`);
      if (ures.status !== 200) throw this.failure("update", ures.status, ures.body);
      session = this.parseSession(ures.body);
    }
    return this.toView(m, session);
  }

  async getCheckout(merchantId: string, nativeId: string, traceId: string): Promise<CheckoutView> {
    const m = this.merchant(merchantId);
    const res = await this.call(m, "checkout_sessions.get", "GET", `/checkout_sessions/${nativeId}`, { trace_id: traceId, procurement_request_id: null });
    if (res.status !== 200) throw this.failure("get", res.status, res.body);
    return this.toView(m, this.parseSession(res.body));
  }

  async complete(input: CompletionInput): Promise<CompletionOutcome> {
    const m = this.merchant(input.merchant_id);
    const ctx = { trace_id: input.trace_id, procurement_request_id: input.procurement_request_id };
    const body: AcpCheckoutSessionCompleteRequest = {
      buyer: { ...splitName(input.buyer.name), email: input.buyer.email, phone_number: input.buyer.phone },
      payment_data: { token: resolvePaymentToken(input.payment_credential_ref, input.attempt_id), provider: "stripe" },
    };
    const bv = validateAcp("CheckoutSessionCompleteRequest", body);
    if (!bv.ok) throw new DomainError("native_schema_violation", `outbound ACP complete request invalid: ${bv.errors.join("; ")}`, 500);
    let res;
    try {
      res = await this.call(m, "checkout_sessions.complete", "POST", `/checkout_sessions/${input.native_checkout_id}/complete`, ctx, body, input.idempotency_key, 4000);
    } catch (err) {
      if (err instanceof TransportError) return { kind: "unknown", error: `ACP complete: ${err.kind} — ${err.message}` };
      throw err;
    }
    if (res.status >= 500) return { kind: "unknown", error: `ACP complete returned ${res.status}` };
    if (res.status !== 200) {
      const e = this.parseError(res.body);
      if (e?.code === "idempotency_in_flight") return { kind: "unknown", error: "ACP complete still in flight at merchant" };
      return { kind: "rejected", code: e?.code ?? `http_${res.status}`, reason: e?.message ?? "merchant rejected completion", payment_state: "failed", view: null };
    }
    const session = this.parseSession(res.body);
    const view = this.toView(m, session);
    if (session.status === "completed" && session.order) {
      this.parseSession(res.body, "CheckoutSessionWithOrder");
      return { kind: "ordered", native_order_id: session.order.id, payment_state: "succeeded", view };
    }
    const error = session.messages.find((msg) => msg.type === "error");
    if (session.status === "canceled" || error) {
      return { kind: "rejected", code: error && error.type === "error" ? error.code : session.status, reason: error?.content ?? `session ${session.status}`, payment_state: "failed", view };
    }
    return { kind: "unknown", error: `ACP complete returned status ${session.status} without an order` };
  }

  async reconcile(merchantId: string, nativeCheckoutId: string, traceId: string): Promise<ReconciliationResult> {
    const m = this.merchant(merchantId);
    let res;
    try {
      res = await this.call(m, "checkout_sessions.get(reconcile)", "GET", `/checkout_sessions/${nativeCheckoutId}`, { trace_id: traceId, procurement_request_id: null });
    } catch (err) {
      return { resolution: "still_unknown", native_order_id: null, payment_state: "outcome_unknown", detail: err instanceof Error ? err.message : String(err), view: null };
    }
    if (res.status !== 200) return { resolution: "still_unknown", native_order_id: null, payment_state: "outcome_unknown", detail: `GET returned ${res.status}`, view: null };
    const session = this.parseSession(res.body);
    const view = this.toView(m, session);
    if (session.status === "completed" && session.order) return { resolution: "ordered", native_order_id: session.order.id, payment_state: "succeeded", detail: "merchant reports completed session with order", view };
    if (session.status === "canceled") return { resolution: "canceled", native_order_id: null, payment_state: "failed", detail: "merchant reports canceled session", view };
    return { resolution: "still_unknown", native_order_id: null, payment_state: "outcome_unknown", detail: `merchant session status ${session.status}; completion not (yet) processed`, view };
  }

  private failure(op: string, status: number, body: unknown): DomainError {
    const e = this.parseError(body);
    return new DomainError("merchant_error", `ACP ${op} failed (${status}): ${e ? `${e.type}/${e.code}: ${e.message}` : JSON.stringify(body).slice(0, 300)}`, status >= 500 ? 502 : 422, body);
  }
}
