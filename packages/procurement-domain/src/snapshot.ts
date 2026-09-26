import type { ApprovalSnapshot, CheckoutView, ProcurementRequest } from "./types.ts";
import { digestOf } from "./util.ts";

/**
 * The approval snapshot is the exact set of terms a human approves. It is
 * derived from the *merchant's* checkout view (not from the quote) so that the
 * approval binds to what will actually be charged. Any difference between the
 * approved digest and the digest of a freshly fetched checkout invalidates the
 * approval; the request returns to awaiting_approval.
 */
export function buildApprovalSnapshot(request: ProcurementRequest, view: CheckoutView): ApprovalSnapshot {
  return {
    procurement_request_id: request.id,
    request_version: request.version,
    merchant_id: view.merchant_id,
    protocol: view.protocol,
    protocol_version: view.protocol_version,
    native_checkout_id: view.native_checkout_id,
    currency: view.currency,
    items: view.line_items
      .map((l) => ({ merchant_item_id: l.merchant_item_id, title: l.title, quantity: l.quantity, unit_minor: l.unit_minor, total_minor: l.total_minor }))
      .sort((a, b) => a.merchant_item_id.localeCompare(b.merchant_item_id)),
    quantity: view.line_items.reduce((acc, l) => acc + l.quantity, 0),
    totals: { ...view.totals },
    destination_id: request.destination_id,
    delivery_promise: view.delivery_promise,
    delivery_deadline: request.delivery_deadline,
    terms: { ...view.terms },
  };
}

export function snapshotDigest(snapshot: ApprovalSnapshot): string {
  // request_version is audit metadata; status transitions increment it and must
  // not look like a change to the commercial terms the buyer approved.
  const { request_version: _version, ...terms } = snapshot;
  return digestOf(terms);
}

export interface SnapshotDiff {
  field: string;
  approved: unknown;
  current: unknown;
}

/** Field-level explanation of why two snapshots differ (used in invalidation messages). */
export function diffSnapshots(approved: ApprovalSnapshot, current: ApprovalSnapshot): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];
  const flat = (obj: unknown, prefix: string, out: Map<string, unknown>): void => {
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flat(v, prefix ? `${prefix}.${k}` : k, out);
    } else if (Array.isArray(obj)) {
      obj.forEach((v, i) => flat(v, `${prefix}[${i}]`, out));
      if (obj.length === 0) out.set(prefix, []);
    } else {
      out.set(prefix, obj);
    }
  };
  const a = new Map<string, unknown>();
  const c = new Map<string, unknown>();
  flat(approved, "", a);
  flat(current, "", c);
  for (const key of new Set([...a.keys(), ...c.keys()])) {
    const av = a.get(key);
    const cv = c.get(key);
    if (JSON.stringify(av) !== JSON.stringify(cv)) diffs.push({ field: key, approved: av, current: cv });
  }
  return diffs.sort((x, y) => x.field.localeCompare(y.field));
}
