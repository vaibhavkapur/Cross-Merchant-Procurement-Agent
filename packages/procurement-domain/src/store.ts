import type { Row, SqlExecutor } from "./db/driver.ts";
import type {
  Approval,
  BudgetReservation,
  CheckoutAttempt,
  CostCenter,
  OutboxMessage,
  ProcurementRequest,
  ProtocolEvent,
  Quote,
  Receipt,
  RequestStatus,
  SupplierTask,
  WorkflowEvent,
} from "./types.ts";

const j = (v: unknown): string => JSON.stringify(v ?? null);
const p = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
};
const n = (v: unknown): number => Number(v);
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toRequest(r: Row): ProcurementRequest {
  return {
    id: String(r.id),
    organization_id: String(r.organization_id),
    buyer_id: String(r.buyer_id),
    cost_center_id: String(r.cost_center_id),
    product_constraints: p(r.product_constraints_json, { category: "" }),
    quantity: n(r.quantity),
    delivery_deadline: String(r.delivery_deadline),
    currency: String(r.currency),
    budget_minor: n(r.budget_minor),
    destination_id: String(r.destination_id),
    allowed_merchants: p(r.allowed_merchants_json, []),
    status: String(r.status) as RequestStatus,
    version: n(r.version),
    intent: p(r.intent_json, null),
    missing_fields: p(r.missing_fields_json, []),
    selected_quote_id: s(r.selected_quote_id),
    simulation: p(r.simulation_json, {}),
    source_text: s(r.source_text),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function toSupplierTask(r: Row): SupplierTask {
  return {
    id: String(r.id),
    procurement_request_id: String(r.procurement_request_id),
    supplier_id: String(r.supplier_id),
    a2a_task_id: s(r.a2a_task_id),
    a2a_context_id: s(r.a2a_context_id),
    native_status: String(r.native_status),
    deadline: String(r.deadline),
    last_event_at: s(r.last_event_at),
    artifact_reference: s(r.artifact_reference),
    error: s(r.error),
    created_at: String(r.created_at),
  };
}

function toQuote(r: Row): Quote {
  return {
    id: String(r.id),
    supplier_task_id: String(r.supplier_task_id),
    procurement_request_id: String(r.procurement_request_id),
    supplier_id: String(r.supplier_id),
    merchant_id: String(r.merchant_id),
    native_quote_id: String(r.native_quote_id),
    items: p(r.items_json, []),
    subtotal_minor: n(r.subtotal_minor),
    tax_minor: n(r.tax_minor),
    shipping_minor: n(r.shipping_minor),
    total_minor: n(r.total_minor),
    currency: String(r.currency),
    delivery_date: s(r.delivery_date),
    expires_at: String(r.expires_at),
    quantity_available: n(r.quantity_available),
    eligibility: p(r.eligibility_json, null),
    ranking: p(r.ranking_json, null),
    artifact: p(r.artifact_json, null as never),
    created_at: String(r.created_at),
  };
}

function toAttempt(r: Row): CheckoutAttempt {
  return {
    id: String(r.id),
    procurement_request_id: String(r.procurement_request_id),
    quote_id: String(r.quote_id),
    merchant_id: String(r.merchant_id),
    protocol: String(r.protocol) as CheckoutAttempt["protocol"],
    protocol_version: String(r.protocol_version),
    native_checkout_id: String(r.native_checkout_id),
    native_order_id: s(r.native_order_id),
    native_status: s(r.native_status),
    approved_snapshot_digest: s(r.approved_snapshot_digest),
    idempotency_key: String(r.idempotency_key),
    completion_state: String(r.completion_state) as CheckoutAttempt["completion_state"],
    payment_state: String(r.payment_state) as CheckoutAttempt["payment_state"],
    capability_snapshot: p(r.capability_snapshot_json, null),
    checkout_view: p(r.checkout_view_json, null as never),
    snapshot: p(r.snapshot_json, null as never),
    snapshot_digest: String(r.snapshot_digest),
    last_error: s(r.last_error),
    attempt_no: n(r.attempt_no),
    last_reconciled_at: s(r.last_reconciled_at),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function toApproval(r: Row): Approval {
  return {
    id: String(r.id),
    procurement_request_id: String(r.procurement_request_id),
    checkout_attempt_id: String(r.checkout_attempt_id),
    actor_id: String(r.actor_id),
    snapshot_digest: String(r.snapshot_digest),
    snapshot: p(r.snapshot_json, null as never),
    approved_at: String(r.approved_at),
    expires_at: String(r.expires_at),
    auth_context: p(r.auth_context_json, {}),
    state: String(r.state) as Approval["state"],
    invalidation_reason: s(r.invalidation_reason),
  };
}

function toReservation(r: Row): BudgetReservation {
  return {
    id: String(r.id),
    cost_center_id: String(r.cost_center_id),
    procurement_request_id: String(r.procurement_request_id),
    execution_reference: String(r.execution_reference),
    amount_minor: n(r.amount_minor),
    currency: String(r.currency),
    state: String(r.state) as BudgetReservation["state"],
    created_at: String(r.created_at),
    resolved_at: s(r.resolved_at),
  };
}

function toCostCenter(r: Row): CostCenter {
  return {
    id: String(r.id),
    organization_id: String(r.organization_id),
    name: String(r.name),
    currency: String(r.currency),
    allocated_minor: n(r.allocated_minor),
    committed_minor: n(r.committed_minor),
  };
}

function toOutbox(r: Row): OutboxMessage {
  return {
    id: String(r.id),
    kind: String(r.kind) as OutboxMessage["kind"],
    aggregate_id: String(r.aggregate_id),
    payload: p(r.payload_json, {}),
    available_at: String(r.available_at),
    claimed_at: s(r.claimed_at),
    claimed_by: s(r.claimed_by),
    completed_at: s(r.completed_at),
    attempts: n(r.attempts),
    last_error: s(r.last_error),
    created_at: String(r.created_at),
  };
}

function toProtocolEvent(r: Row): ProtocolEvent {
  return {
    id: String(r.id),
    procurement_request_id: s(r.procurement_request_id),
    trace_id: String(r.trace_id),
    protocol: String(r.protocol) as ProtocolEvent["protocol"],
    direction: String(r.direction) as ProtocolEvent["direction"],
    operation: String(r.operation),
    version: s(r.version),
    counterparty: s(r.counterparty),
    status: s(r.status),
    payload: p(r.payload_json, null),
    created_at: String(r.created_at),
  };
}

function toWorkflowEvent(r: Row): WorkflowEvent {
  return {
    id: String(r.id),
    procurement_request_id: String(r.procurement_request_id),
    from_status: s(r.from_status) as RequestStatus | null,
    to_status: String(r.to_status) as RequestStatus,
    reason: String(r.reason),
    created_at: String(r.created_at),
  };
}

function toReceipt(r: Row): Receipt {
  return {
    id: String(r.id),
    procurement_request_id: String(r.procurement_request_id),
    checkout_attempt_id: String(r.checkout_attempt_id),
    approval_id: String(r.approval_id),
    order_references: p(r.order_references_json, null as never),
    payment_evidence: p(r.payment_evidence_json, null as never),
    final_totals: p(r.final_totals_json, null as never),
    created_at: String(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Repository over a SqlExecutor. Construct with a driver for auto-commit use or
 * with a transaction executor to participate in a transaction.
 */
export class Store {
  readonly db: SqlExecutor;
  constructor(db: SqlExecutor) {
    this.db = db;
  }

  with(tx: SqlExecutor): Store {
    return new Store(tx);
  }

  // Organizations / buyers / cost centers -------------------------------------------------
  async upsertOrganization(id: string, name: string): Promise<void> {
    await this.db.run("INSERT INTO organizations(id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name", [id, name]);
  }

  async upsertBuyer(b: { id: string; organization_id: string; name: string; email: string; can_purchase: boolean }): Promise<void> {
    await this.db.run(
      `INSERT INTO buyers(id, organization_id, name, email, can_purchase) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, can_purchase = excluded.can_purchase`,
      [b.id, b.organization_id, b.name, b.email, b.can_purchase ? 1 : 0],
    );
  }

  async getBuyer(id: string): Promise<{ id: string; organization_id: string; name: string; email: string; can_purchase: boolean } | undefined> {
    const r = await this.db.get("SELECT * FROM buyers WHERE id = ?", [id]);
    return r ? { id: String(r.id), organization_id: String(r.organization_id), name: String(r.name), email: String(r.email), can_purchase: Number(r.can_purchase) === 1 } : undefined;
  }

  async upsertCostCenter(c: CostCenter): Promise<void> {
    await this.db.run(
      `INSERT INTO cost_centers(id, organization_id, name, currency, allocated_minor, committed_minor) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, currency = excluded.currency, allocated_minor = excluded.allocated_minor`,
      [c.id, c.organization_id, c.name, c.currency, c.allocated_minor, c.committed_minor],
    );
  }

  async getCostCenter(id: string, forUpdate = false): Promise<CostCenter | undefined> {
    const suffix = forUpdate && this.db.dialect === "postgres" ? " FOR UPDATE" : "";
    const r = await this.db.get(`SELECT * FROM cost_centers WHERE id = ?${suffix}`, [id]);
    return r ? toCostCenter(r) : undefined;
  }

  async listCostCenters(organizationId: string): Promise<CostCenter[]> {
    return (await this.db.all("SELECT * FROM cost_centers WHERE organization_id = ? ORDER BY id", [organizationId])).map(toCostCenter);
  }

  async updateCostCenterCommitted(id: string, committedMinor: number): Promise<void> {
    await this.db.run("UPDATE cost_centers SET committed_minor = ? WHERE id = ?", [committedMinor, id]);
  }

  // Procurement requests --------------------------------------------------------------------
  async insertRequest(r: ProcurementRequest): Promise<void> {
    await this.db.run(
      `INSERT INTO procurement_requests(id, organization_id, buyer_id, cost_center_id, product_constraints_json, quantity, delivery_deadline,
        currency, budget_minor, destination_id, allowed_merchants_json, status, version, intent_json, missing_fields_json, selected_quote_id,
        simulation_json, source_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id,
        r.organization_id,
        r.buyer_id,
        r.cost_center_id,
        j(r.product_constraints),
        r.quantity,
        r.delivery_deadline,
        r.currency,
        r.budget_minor,
        r.destination_id,
        j(r.allowed_merchants),
        r.status,
        r.version,
        r.intent ? j(r.intent) : null,
        j(r.missing_fields),
        r.selected_quote_id,
        j(r.simulation),
        r.source_text,
        r.created_at,
        r.updated_at,
      ],
    );
  }

  async updateRequest(r: ProcurementRequest): Promise<void> {
    await this.db.run(
      `UPDATE procurement_requests SET cost_center_id = ?, product_constraints_json = ?, quantity = ?, delivery_deadline = ?, currency = ?,
        budget_minor = ?, destination_id = ?, allowed_merchants_json = ?, status = ?, version = ?, intent_json = ?, missing_fields_json = ?,
        selected_quote_id = ?, simulation_json = ?, updated_at = ? WHERE id = ?`,
      [
        r.cost_center_id,
        j(r.product_constraints),
        r.quantity,
        r.delivery_deadline,
        r.currency,
        r.budget_minor,
        r.destination_id,
        j(r.allowed_merchants),
        r.status,
        r.version,
        r.intent ? j(r.intent) : null,
        j(r.missing_fields),
        r.selected_quote_id,
        j(r.simulation),
        r.updated_at,
        r.id,
      ],
    );
  }

  async getRequest(id: string, organizationId?: string): Promise<ProcurementRequest | undefined> {
    const r = organizationId
      ? await this.db.get("SELECT * FROM procurement_requests WHERE id = ? AND organization_id = ?", [id, organizationId])
      : await this.db.get("SELECT * FROM procurement_requests WHERE id = ?", [id]);
    return r ? toRequest(r) : undefined;
  }

  async listRequests(organizationId: string, limit = 50): Promise<ProcurementRequest[]> {
    return (await this.db.all("SELECT * FROM procurement_requests WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?", [organizationId, limit])).map(toRequest);
  }

  async listRequestsByStatus(status: RequestStatus): Promise<ProcurementRequest[]> {
    return (await this.db.all("SELECT * FROM procurement_requests WHERE status = ?", [status])).map(toRequest);
  }

  // Supplier tasks / quotes -----------------------------------------------------------------
  async insertSupplierTask(t: SupplierTask): Promise<void> {
    await this.db.run(
      `INSERT INTO supplier_tasks(id, procurement_request_id, supplier_id, a2a_task_id, a2a_context_id, native_status, deadline, last_event_at, artifact_reference, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.id, t.procurement_request_id, t.supplier_id, t.a2a_task_id, t.a2a_context_id, t.native_status, t.deadline, t.last_event_at, t.artifact_reference, t.error, t.created_at],
    );
  }

  async updateSupplierTask(t: SupplierTask): Promise<void> {
    await this.db.run(
      `UPDATE supplier_tasks SET a2a_task_id = ?, a2a_context_id = ?, native_status = ?, last_event_at = ?, artifact_reference = ?, error = ? WHERE id = ?`,
      [t.a2a_task_id, t.a2a_context_id, t.native_status, t.last_event_at, t.artifact_reference, t.error, t.id],
    );
  }

  async listSupplierTasks(requestId: string): Promise<SupplierTask[]> {
    return (await this.db.all("SELECT * FROM supplier_tasks WHERE procurement_request_id = ? ORDER BY created_at, id", [requestId])).map(toSupplierTask);
  }

  async insertQuote(q: Quote): Promise<void> {
    await this.db.run(
      `INSERT INTO quotes(id, supplier_task_id, procurement_request_id, supplier_id, merchant_id, native_quote_id, items_json, subtotal_minor, tax_minor,
        shipping_minor, total_minor, currency, delivery_date, expires_at, quantity_available, eligibility_json, ranking_json, artifact_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        q.id,
        q.supplier_task_id,
        q.procurement_request_id,
        q.supplier_id,
        q.merchant_id,
        q.native_quote_id,
        j(q.items),
        q.subtotal_minor,
        q.tax_minor,
        q.shipping_minor,
        q.total_minor,
        q.currency,
        q.delivery_date,
        q.expires_at,
        q.quantity_available,
        q.eligibility ? j(q.eligibility) : null,
        q.ranking ? j(q.ranking) : null,
        j(q.artifact),
        q.created_at,
      ],
    );
  }

  async updateQuoteEvaluation(q: Quote): Promise<void> {
    await this.db.run("UPDATE quotes SET eligibility_json = ?, ranking_json = ? WHERE id = ?", [q.eligibility ? j(q.eligibility) : null, q.ranking ? j(q.ranking) : null, q.id]);
  }

  async listQuotes(requestId: string): Promise<Quote[]> {
    return (await this.db.all("SELECT * FROM quotes WHERE procurement_request_id = ? ORDER BY created_at, id", [requestId])).map(toQuote);
  }

  async getQuote(id: string): Promise<Quote | undefined> {
    const r = await this.db.get("SELECT * FROM quotes WHERE id = ?", [id]);
    return r ? toQuote(r) : undefined;
  }

  // Checkout attempts -----------------------------------------------------------------------
  async insertAttempt(a: CheckoutAttempt): Promise<void> {
    await this.db.run(
      `INSERT INTO checkout_attempts(id, procurement_request_id, quote_id, merchant_id, protocol, protocol_version, native_checkout_id, native_order_id,
        native_status, approved_snapshot_digest, idempotency_key, completion_state, payment_state, capability_snapshot_json, checkout_view_json,
        snapshot_json, snapshot_digest, last_error, attempt_no, last_reconciled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.id,
        a.procurement_request_id,
        a.quote_id,
        a.merchant_id,
        a.protocol,
        a.protocol_version,
        a.native_checkout_id,
        a.native_order_id,
        a.native_status,
        a.approved_snapshot_digest,
        a.idempotency_key,
        a.completion_state,
        a.payment_state,
        a.capability_snapshot ? j(a.capability_snapshot) : null,
        j(a.checkout_view),
        j(a.snapshot),
        a.snapshot_digest,
        a.last_error,
        a.attempt_no,
        a.last_reconciled_at,
        a.created_at,
        a.updated_at,
      ],
    );
  }

  async updateAttempt(a: CheckoutAttempt): Promise<void> {
    await this.db.run(
      `UPDATE checkout_attempts SET native_order_id = ?, native_status = ?, approved_snapshot_digest = ?, completion_state = ?, payment_state = ?,
        checkout_view_json = ?, snapshot_json = ?, snapshot_digest = ?, last_error = ?, attempt_no = ?, last_reconciled_at = ?, updated_at = ? WHERE id = ?`,
      [
        a.native_order_id,
        a.native_status,
        a.approved_snapshot_digest,
        a.completion_state,
        a.payment_state,
        j(a.checkout_view),
        j(a.snapshot),
        a.snapshot_digest,
        a.last_error,
        a.attempt_no,
        a.last_reconciled_at,
        a.updated_at,
        a.id,
      ],
    );
  }

  async getAttempt(id: string): Promise<CheckoutAttempt | undefined> {
    const r = await this.db.get("SELECT * FROM checkout_attempts WHERE id = ?", [id]);
    return r ? toAttempt(r) : undefined;
  }

  async listAttempts(requestId: string): Promise<CheckoutAttempt[]> {
    return (await this.db.all("SELECT * FROM checkout_attempts WHERE procurement_request_id = ? ORDER BY created_at, id", [requestId])).map(toAttempt);
  }

  async latestAttempt(requestId: string): Promise<CheckoutAttempt | undefined> {
    const r = await this.db.get("SELECT * FROM checkout_attempts WHERE procurement_request_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [requestId]);
    return r ? toAttempt(r) : undefined;
  }

  async listAttemptsByCompletionState(states: CheckoutAttempt["completion_state"][]): Promise<CheckoutAttempt[]> {
    const marks = states.map(() => "?").join(",");
    return (await this.db.all(`SELECT * FROM checkout_attempts WHERE completion_state IN (${marks}) ORDER BY created_at`, states)).map(toAttempt);
  }

  // Approvals -------------------------------------------------------------------------------
  async insertApproval(a: Approval): Promise<void> {
    await this.db.run(
      `INSERT INTO approvals(id, procurement_request_id, checkout_attempt_id, actor_id, snapshot_digest, snapshot_json, approved_at, expires_at, auth_context_json, state, invalidation_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.id, a.procurement_request_id, a.checkout_attempt_id, a.actor_id, a.snapshot_digest, j(a.snapshot), a.approved_at, a.expires_at, j(a.auth_context), a.state, a.invalidation_reason],
    );
  }

  async updateApprovalState(id: string, state: Approval["state"], reason: string | null): Promise<void> {
    await this.db.run("UPDATE approvals SET state = ?, invalidation_reason = ? WHERE id = ?", [state, reason, id]);
  }

  async activeApproval(requestId: string): Promise<Approval | undefined> {
    const r = await this.db.get("SELECT * FROM approvals WHERE procurement_request_id = ? AND state = 'active' ORDER BY approved_at DESC LIMIT 1", [requestId]);
    return r ? toApproval(r) : undefined;
  }

  async listApprovals(requestId: string): Promise<Approval[]> {
    return (await this.db.all("SELECT * FROM approvals WHERE procurement_request_id = ? ORDER BY approved_at, id", [requestId])).map(toApproval);
  }

  // Budget reservations ---------------------------------------------------------------------
  async insertReservation(r: BudgetReservation): Promise<void> {
    await this.db.run(
      `INSERT INTO budget_reservations(id, cost_center_id, procurement_request_id, execution_reference, amount_minor, currency, state, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.cost_center_id, r.procurement_request_id, r.execution_reference, r.amount_minor, r.currency, r.state, r.created_at, r.resolved_at],
    );
  }

  async activeReservationTotal(costCenterId: string): Promise<number> {
    const r = await this.db.get<{ total: unknown }>("SELECT COALESCE(SUM(amount_minor), 0) AS total FROM budget_reservations WHERE cost_center_id = ? AND state = 'active'", [costCenterId]);
    return Number(r?.total ?? 0);
  }

  async getReservationByReference(reference: string): Promise<BudgetReservation | undefined> {
    const r = await this.db.get("SELECT * FROM budget_reservations WHERE execution_reference = ?", [reference]);
    return r ? toReservation(r) : undefined;
  }

  async listReservations(requestId: string): Promise<BudgetReservation[]> {
    return (await this.db.all("SELECT * FROM budget_reservations WHERE procurement_request_id = ? ORDER BY created_at", [requestId])).map(toReservation);
  }

  async resolveReservation(id: string, state: "committed" | "released", at: string): Promise<void> {
    await this.db.run("UPDATE budget_reservations SET state = ?, resolved_at = ? WHERE id = ? AND state = 'active'", [state, at, id]);
  }

  // Receipts --------------------------------------------------------------------------------
  async insertReceipt(r: Receipt): Promise<void> {
    await this.db.run(
      `INSERT INTO receipts(id, procurement_request_id, checkout_attempt_id, approval_id, order_references_json, payment_evidence_json, final_totals_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.procurement_request_id, r.checkout_attempt_id, r.approval_id, j(r.order_references), j(r.payment_evidence), j(r.final_totals), r.created_at],
    );
  }

  async getReceipt(requestId: string): Promise<Receipt | undefined> {
    const r = await this.db.get("SELECT * FROM receipts WHERE procurement_request_id = ?", [requestId]);
    return r ? toReceipt(r) : undefined;
  }

  // Events ----------------------------------------------------------------------------------
  async insertProtocolEvent(e: ProtocolEvent): Promise<void> {
    await this.db.run(
      `INSERT INTO protocol_events(id, procurement_request_id, trace_id, protocol, direction, operation, version, counterparty, status, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, e.procurement_request_id, e.trace_id, e.protocol, e.direction, e.operation, e.version, e.counterparty, e.status, j(e.payload), e.created_at],
    );
  }

  async listProtocolEvents(requestId: string): Promise<ProtocolEvent[]> {
    return (await this.db.all("SELECT * FROM protocol_events WHERE procurement_request_id = ? ORDER BY created_at, id", [requestId])).map(toProtocolEvent);
  }

  async insertWorkflowEvent(e: WorkflowEvent): Promise<void> {
    await this.db.run("INSERT INTO workflow_events(id, procurement_request_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      e.id,
      e.procurement_request_id,
      e.from_status,
      e.to_status,
      e.reason,
      e.created_at,
    ]);
  }

  async listWorkflowEvents(requestId: string): Promise<WorkflowEvent[]> {
    return (await this.db.all("SELECT * FROM workflow_events WHERE procurement_request_id = ? ORDER BY created_at, id", [requestId])).map(toWorkflowEvent);
  }

  // Outbox ----------------------------------------------------------------------------------
  async insertOutbox(m: OutboxMessage): Promise<void> {
    await this.db.run(
      `INSERT INTO outbox(id, kind, aggregate_id, payload_json, available_at, claimed_at, claimed_by, completed_at, attempts, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [m.id, m.kind, m.aggregate_id, j(m.payload), m.available_at, m.claimed_at, m.claimed_by, m.completed_at, m.attempts, m.last_error, m.created_at],
    );
  }

  /** Claim due messages; a claim older than `staleMs` is considered abandoned (worker crash). */
  async claimOutbox(worker: string, now: string, staleBefore: string, limit = 10): Promise<OutboxMessage[]> {
    const rows = await this.db.all(
      `SELECT * FROM outbox WHERE completed_at IS NULL AND available_at <= ? AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY available_at LIMIT ?`,
      [now, staleBefore, limit],
    );
    const claimed: OutboxMessage[] = [];
    for (const r of rows) {
      const res = await this.db.run(
        "UPDATE outbox SET claimed_at = ?, claimed_by = ?, attempts = attempts + 1 WHERE id = ? AND (claimed_at IS NULL OR claimed_at < ?)",
        [now, worker, String(r.id), staleBefore],
      );
      if (res.changes === 1) {
        const fresh = await this.db.get("SELECT * FROM outbox WHERE id = ?", [String(r.id)]);
        if (fresh) claimed.push(toOutbox(fresh));
      }
    }
    return claimed;
  }

  async completeOutbox(id: string, at: string): Promise<void> {
    await this.db.run("UPDATE outbox SET completed_at = ? WHERE id = ?", [at, id]);
  }

  async failOutbox(id: string, error: string, retryAt: string): Promise<void> {
    await this.db.run("UPDATE outbox SET last_error = ?, claimed_at = NULL, claimed_by = NULL, available_at = ? WHERE id = ?", [error, retryAt, id]);
  }

  async getOutbox(kind: OutboxMessage["kind"], aggregateId: string): Promise<OutboxMessage | undefined> {
    const r = await this.db.get("SELECT * FROM outbox WHERE kind = ? AND aggregate_id = ?", [kind, aggregateId]);
    return r ? toOutbox(r) : undefined;
  }

  async pendingOutboxCount(): Promise<number> {
    const r = await this.db.get<{ c: unknown }>("SELECT COUNT(*) AS c FROM outbox WHERE completed_at IS NULL");
    return Number(r?.c ?? 0);
  }

  // Idempotency -----------------------------------------------------------------------------
  async getIdempotency(scope: string, key: string): Promise<{ request_hash: string; status_code: number; response: unknown } | undefined> {
    const r = await this.db.get("SELECT * FROM idempotency_keys WHERE scope = ? AND idem_key = ?", [scope, key]);
    return r ? { request_hash: String(r.request_hash), status_code: n(r.status_code), response: p(r.response_json, null) } : undefined;
  }

  async putIdempotency(scope: string, key: string, requestHash: string, statusCode: number, response: unknown, at: string): Promise<void> {
    await this.db.run(
      `INSERT INTO idempotency_keys(scope, idem_key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, idem_key) DO NOTHING`,
      [scope, key, requestHash, statusCode, j(response), at],
    );
  }

  // Metrics ---------------------------------------------------------------------------------
  async countAttemptsByState(): Promise<Record<string, number>> {
    const rows = await this.db.all<{ completion_state: string; c: unknown }>("SELECT completion_state, COUNT(*) AS c FROM checkout_attempts GROUP BY completion_state");
    return Object.fromEntries(rows.map((r) => [r.completion_state, Number(r.c)]));
  }

  async countApprovalsByState(): Promise<Record<string, number>> {
    const rows = await this.db.all<{ state: string; c: unknown }>("SELECT state, COUNT(*) AS c FROM approvals GROUP BY state");
    return Object.fromEntries(rows.map((r) => [r.state, Number(r.c)]));
  }
}
