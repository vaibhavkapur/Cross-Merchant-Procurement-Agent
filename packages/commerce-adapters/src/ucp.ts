/**
 * UCP adapter — Universal Commerce Protocol release v2026-08-25, Shopping
 * service over the REST binding with the checkout + fulfillment capabilities.
 *
 * Flow: discover business profile → negotiate capabilities (exact-version
 * intersection with the platform profile) → create checkout → update with the
 * quoted fulfillment option (full replacement) → complete with a payment
 * instrument bound to a negotiated payment handler. Native payloads are
 * validated in both directions against schemas derived from the pinned release.
 */
import {
  UCP_CHECKOUT_CAPABILITY,
  UCP_FULFILLMENT_CAPABILITY,
  UCP_SHOPPING_SERVICE,
  UCP_VERSION,
  intersectCapabilities,
  isUcpErrorResponse,
  validateUcpBusinessProfile,
  validateUcpCheckoutRequest,
  validateUcpCheckoutResponse,
  type UcpBusinessProfile,
  type UcpCapabilityDecl,
  type UcpCheckout,
  type UcpCheckoutRequest,
  type UcpCompleteRequest,
  type UcpErrorResponse,
  type UcpFulfillmentOption,
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
import { ProtocolHttp, TransportError, keyToUuid, resolvePaymentToken } from "./http.ts";

/** Capabilities this platform implements; published at the API's /.well-known/ucp. */
export const PLATFORM_UCP_CAPABILITIES: Record<string, UcpCapabilityDecl[]> = {
  [UCP_CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION, spec: "https://ucp.dev/specification/checkout/", schema: "https://ucp.dev/schemas/shopping/checkout.json" }],
  [UCP_FULFILLMENT_CAPABILITY]: [{ version: UCP_VERSION, spec: "https://ucp.dev/specification/fulfillment/", schema: "https://ucp.dev/schemas/shopping/fulfillment.json", extends: UCP_CHECKOUT_CAPABILITY }],
};

export function platformUcpProfile(profileUrl: string): UcpBusinessProfile {
  return {
    ucp: {
      version: UCP_VERSION,
      services: { [UCP_SHOPPING_SERVICE]: [{ version: UCP_VERSION, spec: "https://ucp.dev/specification/shopping/", transport: "rest", endpoint: profileUrl.replace(/\/\.well-known\/ucp$/, "/ucp/platform") }] },
      capabilities: PLATFORM_UCP_CAPABILITIES,
      payment_handlers: {},
    },
  };
}

export interface UcpAdapterOptions {
  merchants: Merchant[];
  apiKeyFor: (merchant: Merchant) => string;
  http: ProtocolHttp;
  /** Absolute URL of this platform's /.well-known/ucp (sent in UCP-Agent). */
  platformProfileUrl: string;
  clock?: () => Date;
}

const STATUS_MAP: Record<UcpCheckout["status"], NormalizedCheckoutStatus> = {
  incomplete: "incomplete",
  requires_escalation: "blocked",
  ready_for_complete: "ready",
  complete_in_progress: "completing",
  completed: "completed",
  canceled: "canceled",
};

function splitName(name: string): { first_name: string; last_name: string } {
  const parts = name.trim().split(/\s+/);
  return { first_name: parts[0] ?? "Buyer", last_name: parts.slice(1).join(" ") || "Account" };
}

function toPostal(d: Destination) {
  return {
    street_address: d.line_one,
    ...(d.line_two ? { extended_address: d.line_two } : {}),
    address_locality: d.locality,
    address_region: d.region,
    postal_code: d.postal_code,
    address_country: d.country,
    ...splitName(d.contact_name),
    phone_number: d.contact_phone,
  };
}

interface Discovered {
  endpoint: string;
  negotiated: Record<string, UcpCapabilityDecl[]>;
  payment_handlers: Array<{ name: string; id: string }>;
  profile: UcpBusinessProfile;
}

export class UcpAdapter implements CommerceAdapter {
  readonly protocol = "ucp" as const;
  private readonly merchants: Merchant[];
  private readonly apiKeyFor: (merchant: Merchant) => string;
  private readonly http: ProtocolHttp;
  private readonly platformProfileUrl: string;
  private readonly clock: () => Date;
  private readonly discovered = new Map<string, { at: number; value: Discovered }>();

  constructor(opts: UcpAdapterOptions) {
    this.merchants = opts.merchants.filter((m) => m.protocol === "ucp");
    this.apiKeyFor = opts.apiKeyFor;
    this.http = opts.http;
    this.platformProfileUrl = opts.platformProfileUrl;
    this.clock = opts.clock ?? (() => new Date());
  }

  private merchant(id: string): Merchant {
    const m = this.merchants.find((x) => x.id === id);
    if (!m) throw new DomainError("merchant_not_found", `UCP adapter has no merchant ${id}`, 404);
    return m;
  }

  private headers(m: Merchant, traceId: string, idempotencyKey?: string): Record<string, string> {
    return {
      "x-api-key": this.apiKeyFor(m),
      "ucp-agent": `profile="${this.platformProfileUrl}"`,
      "request-id": keyToUuid(`${traceId}:${this.clock().getTime()}:${Math.random()}`),
      "user-agent": "cross-merchant-procurement-agent/0.1 (ucp)",
      ...(idempotencyKey ? { "idempotency-key": keyToUuid(idempotencyKey) } : {}),
    };
  }

  private async discoverInternal(m: Merchant, traceId: string): Promise<Discovered> {
    const cached = this.discovered.get(m.id);
    if (cached && this.clock().getTime() - cached.at < 60_000) return cached.value;
    const res = await this.http.call({ protocol: "ucp", version: UCP_VERSION, operation: "profile.get", merchant_id: m.id, procurement_request_id: null, trace_id: traceId, method: "GET", url: m.discovery_url, headers: {} });
    if (res.status !== 200) throw new DomainError("discovery_failed", `UCP profile fetch returned ${res.status}`, 502);
    const pv = validateUcpBusinessProfile(res.body);
    if (!pv.ok) throw new DomainError("native_schema_violation", `UCP business profile failed schema validation: ${pv.errors.slice(0, 5).join("; ")}`, 502, pv.errors);
    const profile = res.body as UcpBusinessProfile;
    const rest = (profile.ucp.services?.[UCP_SHOPPING_SERVICE] ?? []).find((s) => s.transport === "rest" && s.version === UCP_VERSION);
    if (!rest?.endpoint) throw new DomainError("unsupported_capability", `Merchant ${m.id} exposes no ${UCP_SHOPPING_SERVICE} REST binding at version ${UCP_VERSION}`, 422);
    if (!this.http.isAllowed(rest.endpoint) || new URL(rest.endpoint).origin !== new URL(m.base_url).origin) {
      throw new DomainError("endpoint_not_allowed", `Merchant profile points at ${rest.endpoint}, which is not the approved origin ${m.base_url}`, 422);
    }
    const negotiatedList = intersectCapabilities(PLATFORM_UCP_CAPABILITIES, profile.ucp.capabilities ?? {});
    const negotiated: Record<string, UcpCapabilityDecl[]> = {};
    for (const c of negotiatedList) negotiated[c.name] = [{ version: c.version, ...(c.extends ? { extends: c.extends } : {}) }];
    const payment_handlers: Array<{ name: string; id: string }> = [];
    for (const [name, decls] of Object.entries(profile.ucp.payment_handlers ?? {})) for (const d of decls) if (d.version === UCP_VERSION) payment_handlers.push({ name, id: d.id });
    const value = { endpoint: rest.endpoint.replace(/\/$/, ""), negotiated, payment_handlers, profile };
    this.discovered.set(m.id, { at: this.clock().getTime(), value });
    return value;
  }

  async discover(merchantId: string, traceId: string): Promise<CapabilitySnapshot> {
    const m = this.merchant(merchantId);
    const d = await this.discoverInternal(m, traceId);
    const caps = Object.entries(d.negotiated).map(([name, decls]) => `${name}@${decls[0]?.version}`);
    return {
      merchant_id: m.id,
      protocol: "ucp",
      protocol_version: d.profile.ucp.version,
      endpoint: d.endpoint,
      capabilities: caps,
      payment_handlers: d.payment_handlers.map((h) => `${h.name}#${h.id}`),
      supports_checkout: !!d.negotiated[UCP_CHECKOUT_CAPABILITY] && !!d.negotiated[UCP_FULFILLMENT_CAPABILITY],
      discovered_at: this.clock().toISOString(),
      native: d.profile,
    };
  }

  private parseCheckout(body: unknown): UcpCheckout {
    const v = validateUcpCheckoutResponse(body);
    if (!v.ok) throw new DomainError("native_schema_violation", `UCP checkout response failed schema validation: ${v.errors.slice(0, 5).join("; ")}`, 502, v.errors);
    return body as UcpCheckout;
  }

  toView(m: Merchant, c: UcpCheckout): CheckoutView {
    const total = (type: string) => c.totals.find((t) => t.type === type)?.amount ?? 0;
    const method = c.fulfillment?.methods?.[0];
    const group = method?.groups?.[0];
    const option: UcpFulfillmentOption | undefined = group?.options?.find((o) => o.id === group.selected_option_id);
    const terms: Record<string, string> = {};
    for (const l of c.links) terms[`link:${l.type}`] = l.url;
    if (option) terms["fulfillment_option_title"] = option.title;
    if (option?.carrier) terms["carrier"] = option.carrier;
    if (c.order) terms["order_permalink"] = c.order.permalink_url;
    const handlerEntry = Object.entries(c.ucp.payment_handlers ?? {})[0];
    return {
      protocol: "ucp",
      protocol_version: c.ucp.version,
      merchant_id: m.id,
      native_checkout_id: c.id,
      native_status: c.status,
      normalized_status: STATUS_MAP[c.status],
      currency: c.currency.toUpperCase(),
      line_items: c.line_items.map((l) => ({
        native_line_id: l.id ?? l.item.id,
        merchant_item_id: l.item.id,
        title: l.item.title ?? l.item.id,
        quantity: l.quantity,
        unit_minor: l.item.price ?? null,
        total_minor: l.totals?.find((t) => t.type === "total")?.amount ?? 0,
      })),
      totals: { subtotal_minor: total("subtotal"), tax_minor: total("tax"), shipping_minor: total("fulfillment"), fees_minor: total("fee"), total_minor: total("total") },
      delivery_promise: option?.latest_fulfillment_time ?? option?.earliest_fulfillment_time ?? null,
      fulfillment_option: group?.selected_option_id ?? null,
      payment_handler: handlerEntry ? { id: handlerEntry[1][0]?.id ?? handlerEntry[0], type: handlerEntry[0] } : null,
      native_order_id: c.order?.id ?? null,
      messages: (c.messages ?? []).map((msg) => ({ type: msg.type, code: "code" in msg && msg.code ? msg.code : null, content: msg.content })),
      terms,
      native: c,
    };
  }

  private outboundCheck(op: "create" | "update" | "complete", body: unknown): void {
    const v = validateUcpCheckoutRequest(op, body);
    if (!v.ok) throw new DomainError("native_schema_violation", `outbound UCP ${op} request invalid: ${v.errors.join("; ")}`, 500);
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutView> {
    const m = this.merchant(input.merchant_id);
    const d = await this.discoverInternal(m, input.trace_id);
    if (!d.negotiated[UCP_CHECKOUT_CAPABILITY] || !d.negotiated[UCP_FULFILLMENT_CAPABILITY]) {
      throw new DomainError("unsupported_capability", `Merchant ${m.id} did not negotiate ${UCP_CHECKOUT_CAPABILITY} + ${UCP_FULFILLMENT_CAPABILITY} at ${UCP_VERSION}`, 422);
    }
    const ctx = { procurement_request_id: input.procurement_request_id, trace_id: input.trace_id };
    const buyer = { ...splitName(input.destination.contact_name), email: input.destination.contact_email, phone_number: input.destination.contact_phone };
    const create: UcpCheckoutRequest = {
      line_items: input.quote.items.map((i) => ({ item: { id: i.merchant_item_id }, quantity: i.quantity })),
      buyer,
      fulfillment: { methods: [{ type: "shipping", destinations: [toPostal(input.destination)] }] },
    };
    this.outboundCheck("create", create);
    const sim: Record<string, string> = Object.keys(input.simulation).length ? { "x-fixture-simulation": JSON.stringify(input.simulation) } : {};
    const res = await this.http.call({
      protocol: "ucp",
      version: UCP_VERSION,
      operation: "checkout.create",
      merchant_id: m.id,
      ...ctx,
      method: "POST",
      url: `${d.endpoint}/checkout-sessions`,
      headers: { ...this.headers(m, input.trace_id, `${input.idempotency_key}:create`), ...sim },
      body: create,
    });
    if (res.status !== 201) throw this.failure("create", res.status, res.body);
    let checkout = this.parseCheckout(res.body);
    if (checkout.currency.toUpperCase() !== input.currency.toUpperCase()) throw new DomainError("currency_mismatch", `Merchant checkout currency ${checkout.currency} differs from ${input.currency}`, 422);

    // Full-replacement update selecting the quoted fulfillment option.
    const method = checkout.fulfillment?.methods?.find((x) => x.type === "shipping");
    const group = method?.groups?.[0];
    const wanted = input.quote.artifact.delivery.method;
    if (!method || !group) throw new DomainError("unsupported_capability", "Merchant returned no shipping fulfillment method", 422);
    if (!group.options?.some((o) => o.id === wanted)) {
      throw new DomainError("fulfillment_option_unavailable", `Quoted fulfillment option ${wanted} not offered by merchant (offered: ${(group.options ?? []).map((o) => o.id).join(", ")})`, 422);
    }
    const lineIds = checkout.line_items.map((l) => l.id!);
    const update: UcpCheckoutRequest = {
      line_items: checkout.line_items.map((l) => ({ id: l.id, item: { id: l.item.id }, quantity: l.quantity })),
      buyer,
      fulfillment: {
        methods: [
          {
            id: method.id,
            type: "shipping",
            line_item_ids: lineIds,
            selected_destination_id: method.selected_destination_id ?? method.destinations?.[0]?.id ?? null,
            groups: [{ id: group.id, selected_option_id: wanted }],
          },
        ],
      },
    };
    this.outboundCheck("update", update);
    const ures = await this.http.call({
      protocol: "ucp",
      version: UCP_VERSION,
      operation: "checkout.update",
      merchant_id: m.id,
      ...ctx,
      method: "PUT",
      url: `${d.endpoint}/checkout-sessions/${checkout.id}`,
      headers: this.headers(m, input.trace_id, `${input.idempotency_key}:update`),
      body: update,
    });
    if (ures.status !== 200) throw this.failure("update", ures.status, ures.body);
    checkout = this.parseCheckout(ures.body);
    return this.toView(m, checkout);
  }

  async getCheckout(merchantId: string, nativeId: string, traceId: string): Promise<CheckoutView> {
    const m = this.merchant(merchantId);
    const d = await this.discoverInternal(m, traceId);
    const res = await this.http.call({ protocol: "ucp", version: UCP_VERSION, operation: "checkout.get", merchant_id: m.id, procurement_request_id: null, trace_id: traceId, method: "GET", url: `${d.endpoint}/checkout-sessions/${nativeId}`, headers: this.headers(m, traceId) });
    if (res.status !== 200) throw this.failure("get", res.status, res.body);
    return this.toView(m, this.parseCheckout(res.body));
  }

  async complete(input: CompletionInput): Promise<CompletionOutcome> {
    const m = this.merchant(input.merchant_id);
    const d = await this.discoverInternal(m, input.trace_id);
    const handler = d.payment_handlers[0];
    if (!handler) return { kind: "rejected", code: "no_payment_handler", reason: "merchant advertises no payment handler at the negotiated version", payment_state: "failed", view: null };
    const destinationLike = { street_address: "on file", address_locality: "on file", address_region: "on file", postal_code: "00000", address_country: "US" };
    const body: UcpCompleteRequest = {
      payment: {
        instruments: [
          {
            id: `pi_${input.attempt_id}`,
            handler_id: handler.id,
            type: "card",
            selected: true,
            credential: { type: "fixture_card_token", token: resolvePaymentToken(input.payment_credential_ref, input.attempt_id) },
            billing_address: destinationLike,
          },
        ],
      },
    };
    this.outboundCheck("complete", body);
    let res;
    try {
      res = await this.http.call({
        protocol: "ucp",
        version: UCP_VERSION,
        operation: "checkout.complete",
        merchant_id: m.id,
        procurement_request_id: input.procurement_request_id,
        trace_id: input.trace_id,
        method: "POST",
        url: `${d.endpoint}/checkout-sessions/${input.native_checkout_id}/complete`,
        headers: this.headers(m, input.trace_id, input.idempotency_key),
        body,
        timeoutMs: 4000,
      });
    } catch (err) {
      if (err instanceof TransportError) return { kind: "unknown", error: `UCP complete: ${err.kind} — ${err.message}` };
      throw err;
    }
    if (res.status >= 500) return { kind: "unknown", error: `UCP complete returned ${res.status}` };
    if (isUcpErrorResponse(res.body)) {
      const e = res.body as UcpErrorResponse;
      const code = e.messages[0]?.type === "error" ? e.messages[0].code : "error";
      if (code === "idempotency_in_flight") return { kind: "unknown", error: "UCP complete still in flight at merchant" };
      return { kind: "rejected", code, reason: e.messages.map((x) => x.content).join("; "), payment_state: "failed", view: null };
    }
    if (res.status !== 200) return { kind: "rejected", code: `http_${res.status}`, reason: "merchant rejected completion", payment_state: "failed", view: null };
    const checkout = this.parseCheckout(res.body);
    const view = this.toView(m, checkout);
    if (checkout.status === "completed" && checkout.order) return { kind: "ordered", native_order_id: checkout.order.id, payment_state: "succeeded", view };
    const error = (checkout.messages ?? []).find((msg) => msg.type === "error");
    if (checkout.status === "canceled" || error) {
      return { kind: "rejected", code: error && error.type === "error" ? error.code : checkout.status, reason: error?.content ?? `checkout ${checkout.status}`, payment_state: "failed", view };
    }
    if (checkout.status === "complete_in_progress") return { kind: "unknown", error: "merchant reports complete_in_progress" };
    return { kind: "unknown", error: `UCP complete returned status ${checkout.status} without an order` };
  }

  async reconcile(merchantId: string, nativeCheckoutId: string, traceId: string): Promise<ReconciliationResult> {
    const m = this.merchant(merchantId);
    let view: CheckoutView;
    try {
      view = await this.getCheckout(m.id, nativeCheckoutId, traceId);
    } catch (err) {
      return { resolution: "still_unknown", native_order_id: null, payment_state: "outcome_unknown", detail: err instanceof Error ? err.message : String(err), view: null };
    }
    if (view.normalized_status === "completed" && view.native_order_id) return { resolution: "ordered", native_order_id: view.native_order_id, payment_state: "succeeded", detail: "merchant reports completed checkout with order", view };
    if (view.normalized_status === "canceled") return { resolution: "canceled", native_order_id: null, payment_state: "failed", detail: "merchant reports canceled checkout", view };
    return { resolution: "still_unknown", native_order_id: null, payment_state: "outcome_unknown", detail: `merchant checkout status ${view.native_status}; completion not (yet) processed`, view };
  }

  private failure(op: string, status: number, body: unknown): DomainError {
    const detail = isUcpErrorResponse(body) ? body.messages.map((x) => `${"code" in x ? x.code : x.type}: ${x.content}`).join("; ") : JSON.stringify(body).slice(0, 300);
    return new DomainError("merchant_error", `UCP ${op} failed (${status}): ${detail}`, status >= 500 ? 502 : 422, body);
  }
}
