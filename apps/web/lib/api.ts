const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
const TOKEN = process.env.NEXT_PUBLIC_BUYER_TOKEN ?? "fixture-token-alice";

async function req<T>(path: string, init: RequestInit & { idempotency?: string } = {}): Promise<T> {
  const { idempotency, headers, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(idempotency ? { "idempotency-key": idempotency } : {}),
      ...headers,
    },
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.message ?? res.statusText) as Error & { status: number; body: unknown };
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json as T;
}

export const api = {
  meta: () => req<{ organization: { name: string }; scenarios: Record<string, { title: string; text: string; expect: string }>; cost_centers: Array<{ id: string; name: string }>; destinations: Array<{ destination_id: string; name: string }> }>("/v1/meta"),
  list: () => req<{ requests: Array<{ id: string; status: string; quantity: number; budget_minor: number; currency: string; created_at: string; product_constraints: { category: string } }> }>("/v1/procurement-requests"),
  create: (body: unknown, idem: string) => req<{ request: { id: string }; intent: unknown }>("/v1/procurement-requests", { method: "POST", body: JSON.stringify(body), idempotency: idem }),
  solicit: (id: string, idem: string) => req<{ request: unknown; quotes: unknown[] }>(`/v1/procurement-requests/${id}/solicit-quotes`, { method: "POST", body: "{}", idempotency: idem }),
  select: (id: string, quoteId: string, idem: string) => req(`/v1/procurement-requests/${id}/select-quote`, { method: "POST", body: JSON.stringify({ quote_id: quoteId }), idempotency: idem }),
  approve: (id: string, idem: string) => req(`/v1/procurement-requests/${id}/approve`, { method: "POST", body: "{}", idempotency: idem }),
  execute: (id: string, idem: string) => req(`/v1/procurement-requests/${id}/execute`, { method: "POST", body: "{}", idempotency: idem }),
  timeline: (id: string) => req<Timeline>(`/v1/procurement-requests/${id}/timeline`),
};

export interface Timeline {
  request: {
    id: string;
    status: string;
    quantity: number;
    budget_minor: number;
    currency: string;
    delivery_deadline: string;
    cost_center_id: string;
    destination_id: string;
    product_constraints: { category: string; minimum_size_inches?: number };
    missing_fields: string[];
    simulation: Record<string, unknown>;
    source_text: string | null;
  };
  quotes: Array<{
    id: string;
    merchant_id: string;
    supplier_id: string;
    total_minor: number;
    currency: string;
    delivery_date: string | null;
    eligibility: { eligible: boolean; checks: Array<{ constraint: string; passed: boolean; detail: string }>; failed: string[] } | null;
    ranking: { rank: number | null; summary: string } | null;
  }>;
  attempts: Array<{
    id: string;
    protocol: string;
    protocol_version: string;
    native_checkout_id: string;
    native_order_id: string | null;
    completion_state: string;
    payment_state: string;
    snapshot: { totals: { total_minor: number; shipping_minor: number; tax_minor: number; subtotal_minor: number }; currency: string; merchant_id: string; items: Array<{ title: string; quantity: number; total_minor: number }> };
    snapshot_digest: string;
    last_error: string | null;
  }>;
  approvals: Array<{ id: string; state: string; snapshot_digest: string; actor_id: string; approved_at: string; invalidation_reason: string | null }>;
  workflow_events: Array<{ from_status: string | null; to_status: string; reason: string; created_at: string }>;
  protocol_events: Array<{ protocol: string; direction: string; operation: string; counterparty: string | null; status: string | null; payload: unknown; created_at: string }>;
  receipt: { order_references: { merchant_id: string; protocol: string; native_order_id: string; native_checkout_id: string }; payment_evidence: { payment_state: string; handler: string | null }; final_totals: { total_minor: number; currency: string } } | null;
  budget: { available_minor: number; active_reserved_minor: number; cost_center: { allocated_minor: number; committed_minor: number; name: string } } | null;
}

export function money(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}
