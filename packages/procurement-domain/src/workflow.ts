import type { Logger, ProtocolRecorder } from "@procurement/audit";
import { assertCanApprove, assertCanPurchase, assertCanRequest, evaluatePurchasePolicy, evaluateRequestPolicy, approvedMerchantIds, scanUntrustedText, type Principal, type PurchasingPolicy } from "@procurement/policy";
import { validateQuoteArtifact, type MerchantProtocol, type QuoteArtifact } from "@procurement/protocol-contracts";
import { compareQuotes, type RankingPreference } from "./comparison.ts";
import type { SqlDriver, SqlExecutor } from "./db/driver.ts";
import { BudgetLedger, type BudgetView } from "./ledger.ts";
import { buildApprovalSnapshot, diffSnapshots, snapshotDigest } from "./snapshot.ts";
import { assertCompletionTransition, assertPaymentTransition, assertTransition, TERMINAL_STATUSES } from "./state.ts";
import { Store } from "./store.ts";
import type {
  Approval,
  BudgetReservation,
  CapabilitySnapshot,
  CheckoutAttempt,
  CheckoutView,
  CommerceAdapter,
  CompletionOutcome,
  Destination,
  IntentDraft,
  Merchant,
  OutboxMessage,
  ProcurementRequest,
  ProtocolEvent,
  Quote,
  Receipt,
  RequestStatus,
  SimulationFlags,
  Supplier,
  SupplierTask,
  WorkflowEvent,
} from "./types.ts";
import { DomainError, invariant, iso, newId, type Clock } from "./util.ts";

export interface WorkflowDeps {
  driver: SqlDriver;
  adapters: Partial<Record<MerchantProtocol, CommerceAdapter>>;
  merchants: Merchant[];
  suppliers: Supplier[];
  destinations: Destination[];
  policyFor: (organizationId: string) => PurchasingPolicy;
  recorder: ProtocolRecorder;
  logger: Logger;
  clock: Clock;
  /** Opaque vault reference; the agent never handles raw payment credentials. */
  paymentCredentialRef: string;
  ranking?: RankingPreference;
  /** Delay before the first reconciliation probe after an unknown outcome. */
  reconcileDelayMs?: number;
  /** After this many still-unknown probes, re-send the identical complete call (same idempotency key). */
  retryCompleteAfterProbes?: number;
}

export interface CreateRequestInput {
  principal: Principal;
  intent: IntentDraft;
  source_text: string | null;
  simulation?: SimulationFlags;
}

export interface Timeline {
  request: ProcurementRequest;
  workflow_events: WorkflowEvent[];
  protocol_events: ProtocolEvent[];
  supplier_tasks: SupplierTask[];
  quotes: Quote[];
  attempts: CheckoutAttempt[];
  approvals: Approval[];
  reservations: BudgetReservation[];
  receipt: Receipt | null;
  budget: BudgetView | null;
}

const REQUIRED_INTENT_FIELDS: Array<keyof IntentDraft> = ["quantity", "budget_minor", "delivery_deadline", "destination_id", "cost_center_id"];

/**
 * ProcurementWorkflow owns every state transition of a procurement request.
 * Network calls (adapter discovery, checkout, completion) always happen
 * *outside* database transactions; the resulting facts are then written in a
 * single transaction together with the budget/outbox side effects.
 */
export class ProcurementWorkflow {
  readonly store: Store;
  private readonly deps: WorkflowDeps;

  constructor(deps: WorkflowDeps) {
    this.deps = deps;
    this.store = new Store(deps.driver);
  }

  get clock(): Clock {
    return this.deps.clock;
  }

  private now(): string {
    return iso(this.deps.clock());
  }

  private tx<T>(fn: (store: Store, tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.deps.driver.transaction((tx) => fn(new Store(tx), tx));
  }

  merchant(id: string): Merchant {
    const m = this.deps.merchants.find((x) => x.id === id);
    if (!m) throw new DomainError("merchant_not_found", `Unknown merchant ${id}`, 404);
    return m;
  }

  adapterFor(merchantId: string): CommerceAdapter {
    const m = this.merchant(merchantId);
    const a = this.deps.adapters[m.protocol];
    if (!a) throw new DomainError("adapter_unavailable", `No ${m.protocol} adapter configured`, 500);
    return a;
  }

  destination(id: string): Destination {
    const d = this.deps.destinations.find((x) => x.destination_id === id);
    if (!d) throw new DomainError("destination_not_found", `Unknown destination ${id}`, 404);
    return d;
  }

  private async transition(store: Store, request: ProcurementRequest, to: RequestStatus, reason: string): Promise<void> {
    const from = request.status;
    if (from !== to) assertTransition(from, to);
    request.status = to;
    request.version += 1;
    request.updated_at = this.now();
    await store.updateRequest(request);
    await store.insertWorkflowEvent({ id: newId("wev"), procurement_request_id: request.id, from_status: from, to_status: to, reason, created_at: request.updated_at });
    this.deps.logger.info("request_transition", { request_id: request.id, from, to, reason });
  }

  // -------------------------------------------------------------------------
  // Request creation
  // -------------------------------------------------------------------------
  async createRequest(input: CreateRequestInput): Promise<ProcurementRequest> {
    const { principal, intent } = input;
    assertCanRequest(principal, principal.organization_id);
    const policy = this.deps.policyFor(principal.organization_id);
    const missing = REQUIRED_INTENT_FIELDS.filter((f) => intent[f] === null || intent[f] === undefined);
    if (!intent.product.category) missing.push("product");
    const now = this.now();
    const allowed = intent.allowed_merchants ?? approvedMerchantIds(policy, intent.product.category);
    const request: ProcurementRequest = {
      id: newId("pr"),
      organization_id: principal.organization_id,
      buyer_id: principal.id,
      cost_center_id: intent.cost_center_id ?? "",
      product_constraints: intent.product,
      quantity: intent.quantity ?? 0,
      delivery_deadline: intent.delivery_deadline ?? "",
      currency: intent.currency || policy.currency,
      budget_minor: intent.budget_minor ?? 0,
      destination_id: intent.destination_id ?? "",
      allowed_merchants: allowed,
      status: "draft",
      version: 1,
      intent,
      missing_fields: missing,
      selected_quote_id: null,
      simulation: input.simulation ?? {},
      source_text: input.source_text,
      created_at: now,
      updated_at: now,
    };
    if (missing.length === 0) {
      const decision = evaluateRequestPolicy(policy, {
        currency: request.currency,
        budget_minor: request.budget_minor,
        quantity: request.quantity,
        category: request.product_constraints.category,
        allowed_merchants: request.allowed_merchants,
      });
      if (!decision.allowed) throw new DomainError("policy_violation", "Request violates purchasing policy", 422, decision.checks.filter((c) => !c.passed));
      this.destination(request.destination_id);
      const cc = await this.store.getCostCenter(request.cost_center_id);
      if (!cc || cc.organization_id !== principal.organization_id) throw new DomainError("cost_center_not_found", `Unknown cost centre ${request.cost_center_id}`, 404);
    }
    await this.tx(async (store) => {
      await store.insertRequest(request);
      await store.insertWorkflowEvent({ id: newId("wev"), procurement_request_id: request.id, from_status: null, to_status: "draft", reason: missing.length ? `created; missing ${missing.join(", ")}` : "created", created_at: now });
    });
    return request;
  }

  async getRequest(id: string, principal: Principal): Promise<ProcurementRequest> {
    const r = await this.store.getRequest(id, principal.organization_id);
    if (!r) throw new DomainError("not_found", `Procurement request ${id} not found`, 404);
    return r;
  }

  // -------------------------------------------------------------------------
  // Quote collection (the A2A client in apps/api drives these)
  // -------------------------------------------------------------------------
  async beginQuoteCollection(requestId: string, principal: Principal, supplierIds: string[], deadline: string): Promise<{ request: ProcurementRequest; tasks: SupplierTask[] }> {
    const request = await this.getRequest(requestId, principal);
    invariant(request.missing_fields.length === 0, "incomplete_request", `Request is missing: ${request.missing_fields.join(", ")}`, 422);
    invariant(["draft", "collecting_quotes", "comparing"].includes(request.status), "invalid_state", `Cannot solicit quotes in status ${request.status}`);
    const now = this.now();
    const tasks: SupplierTask[] = supplierIds.map((sid) => ({
      id: newId("stask"),
      procurement_request_id: request.id,
      supplier_id: sid,
      a2a_task_id: null,
      a2a_context_id: null,
      native_status: "submitted",
      deadline,
      last_event_at: null,
      artifact_reference: null,
      error: null,
      created_at: now,
    }));
    await this.tx(async (store) => {
      for (const t of tasks) await store.insertSupplierTask(t);
      await this.transition(store, request, "collecting_quotes", `RFQ sent to ${supplierIds.join(", ")}`);
    });
    return { request, tasks };
  }

  async updateSupplierTask(task: SupplierTask): Promise<void> {
    task.last_event_at = this.now();
    await this.store.updateSupplierTask(task);
  }

  /** Validate + persist a quote artifact returned by a supplier agent. */
  async recordQuote(task: SupplierTask, artifact: unknown): Promise<Quote> {
    const validation = validateQuoteArtifact(artifact);
    if (!validation.ok) {
      throw new DomainError("invalid_quote_artifact", `Supplier ${task.supplier_id} returned an invalid quote artifact`, 422, validation.errors);
    }
    const a = artifact as QuoteArtifact;
    if (a.supplier_id !== task.supplier_id) throw new DomainError("quote_supplier_mismatch", `Artifact supplier ${a.supplier_id} does not match task supplier ${task.supplier_id}`, 422);
    const scan = scanUntrustedText(a.notes);
    if (scan.suspicious) {
      this.deps.logger.warn("suspicious_supplier_text", { supplier_id: task.supplier_id, matches: scan.matches });
    }
    const now = this.now();
    const quote: Quote = {
      id: newId("q"),
      supplier_task_id: task.id,
      procurement_request_id: task.procurement_request_id,
      supplier_id: a.supplier_id,
      merchant_id: a.merchant.merchant_id,
      native_quote_id: a.native_quote_id,
      items: a.items,
      subtotal_minor: a.price.subtotal_minor,
      tax_minor: a.price.tax_minor,
      shipping_minor: a.price.shipping_minor,
      total_minor: a.price.total_minor,
      currency: a.price.currency,
      delivery_date: a.delivery.promised_by,
      expires_at: a.expires_at,
      quantity_available: a.quantity_available,
      eligibility: scan.suspicious
        ? { eligible: false, checks: [{ constraint: "untrusted_content", passed: false, detail: `supplier notes contain instruction-like text (${scan.matches.length} pattern(s)); flagged for audit` }], failed: ["untrusted_content"] }
        : null,
      ranking: null,
      artifact: a,
      created_at: now,
    };
    await this.tx(async (store) => {
      await store.insertQuote(quote);
      task.native_status = "completed";
      task.artifact_reference = quote.id;
      task.last_event_at = now;
      await store.updateSupplierTask(task);
    });
    return quote;
  }

  /** Compare all collected quotes, persist explanations, and move to `comparing`. */
  async finishQuoteCollection(requestId: string, principal: Principal, capabilities: Record<string, CapabilitySnapshot | undefined>): Promise<Quote[]> {
    const request = await this.getRequest(requestId, principal);
    const policy = this.deps.policyFor(request.organization_id);
    const quotes = await this.store.listQuotes(request.id);
    const candidates = quotes.filter((q) => !q.eligibility || q.eligibility.eligible !== false || !q.eligibility.failed.includes("untrusted_content"));
    const outcomes = compareQuotes(
      candidates.map((q) => ({ quote_id: q.id, artifact: q.artifact })),
      {
        request: {
          product: request.product_constraints,
          quantity: request.quantity,
          currency: request.currency,
          budget_minor: request.budget_minor,
          delivery_deadline: request.delivery_deadline,
          allowed_merchants: request.allowed_merchants,
        },
        approved_merchants: approvedMerchantIds(policy, request.product_constraints.category),
        capabilities,
        now: this.deps.clock(),
        ranking: this.deps.ranking,
        min_quote_validity_ms: policy.min_quote_validity_minutes * 60_000,
      },
    );
    await this.tx(async (store) => {
      for (const q of quotes) {
        const o = outcomes.find((x) => x.quote_id === q.id);
        if (o) {
          q.eligibility = o.eligibility;
          q.ranking = o.ranking;
        } else if (q.eligibility && !q.ranking) {
          q.ranking = { rank: null, delivered_total_minor: q.total_minor, delivery_buffer_hours: null, preference_score: 0, summary: `Ineligible: ${q.eligibility.checks.map((c) => c.detail).join("; ")}` };
        }
        await store.updateQuoteEvaluation(q);
      }
      const eligible = quotes.filter((q) => q.eligibility?.eligible).length;
      await this.transition(store, request, "comparing", `${quotes.length} quote(s) compared, ${eligible} eligible`);
    });
    return quotes;
  }

  // -------------------------------------------------------------------------
  // Selection → merchant checkout → approval snapshot
  // -------------------------------------------------------------------------
  async selectQuote(requestId: string, quoteId: string, principal: Principal, traceId: string): Promise<{ request: ProcurementRequest; attempt: CheckoutAttempt }> {
    const request = await this.getRequest(requestId, principal);
    assertCanPurchase(principal, request.organization_id);
    invariant(["comparing", "awaiting_approval"].includes(request.status), "invalid_state", `Cannot select a quote in status ${request.status}`);
    const quote = await this.store.getQuote(quoteId);
    invariant(quote && quote.procurement_request_id === request.id, "quote_not_found", `Quote ${quoteId} does not belong to this request`, 404);
    invariant(quote.eligibility?.eligible, "quote_ineligible", `Quote ${quoteId} is not eligible: ${quote.eligibility?.failed.join(", ") ?? "not evaluated"}`, 422);
    invariant(new Date(quote.expires_at).getTime() > this.deps.clock().getTime(), "quote_expired", `Quote ${quoteId} expired at ${quote.expires_at}`, 422);

    const adapter = this.adapterFor(quote.merchant_id);
    const capability = await adapter.discover(quote.merchant_id, traceId);
    invariant(capability.supports_checkout && capability.payment_handlers.length > 0, "unsupported_capability", `Merchant ${quote.merchant_id} does not advertise a supported checkout/payment path`, 422);

    const idempotencyKey = newId("idem");
    const view = await adapter.createCheckout({
      procurement_request_id: request.id,
      merchant_id: quote.merchant_id,
      quote,
      currency: request.currency,
      destination: this.destination(request.destination_id),
      idempotency_key: idempotencyKey,
      trace_id: traceId,
      simulation: request.simulation,
    });
    const snapshot = buildApprovalSnapshot(request, view);
    const now = this.now();
    const attempt: CheckoutAttempt = {
      id: newId("att"),
      procurement_request_id: request.id,
      quote_id: quote.id,
      merchant_id: quote.merchant_id,
      protocol: view.protocol,
      protocol_version: view.protocol_version,
      native_checkout_id: view.native_checkout_id,
      native_order_id: null,
      native_status: view.native_status,
      approved_snapshot_digest: null,
      idempotency_key: idempotencyKey,
      completion_state: "pending",
      payment_state: "not_started",
      capability_snapshot: capability,
      checkout_view: view,
      snapshot,
      snapshot_digest: snapshotDigest(snapshot),
      last_error: null,
      attempt_no: 1,
      last_reconciled_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.tx(async (store) => {
      // Any previously active approval for another checkout is void.
      const active = await store.activeApproval(request.id);
      if (active) await store.updateApprovalState(active.id, "invalidated", "different quote selected");
      await store.insertAttempt(attempt);
      request.selected_quote_id = quote.id;
      await this.transition(store, request, "awaiting_approval", `quote ${quote.id} selected; ${view.protocol} checkout ${view.native_checkout_id} created`);
    });
    return { request, attempt };
  }

  async currentAttempt(request: ProcurementRequest): Promise<CheckoutAttempt> {
    const attempts = await this.store.listAttempts(request.id);
    const attempt = [...attempts].reverse().find((a) => a.quote_id === request.selected_quote_id);
    if (!attempt) throw new DomainError("no_checkout", "No checkout has been created for the selected quote", 409);
    return attempt;
  }

  /**
   * Re-fetch the merchant checkout and compare its digest to the attempt's
   * snapshot. When terms differ, the attempt is refreshed, any active approval
   * is invalidated and a 409 is raised carrying the field-level diff.
   */
  private async refreshAndCompare(request: ProcurementRequest, attempt: CheckoutAttempt, traceId: string, expectedDigest: string, invalidateReason: string): Promise<CheckoutView> {
    const adapter = this.adapterFor(attempt.merchant_id);
    const view = await adapter.getCheckout(attempt.merchant_id, attempt.native_checkout_id, traceId);
    const fresh = buildApprovalSnapshot(request, view);
    const digest = snapshotDigest(fresh);
    if (digest === expectedDigest) return view;

    const diff = diffSnapshots(attempt.snapshot, fresh);
    await this.tx(async (store) => {
      const active = await store.activeApproval(request.id);
      if (active) await store.updateApprovalState(active.id, "invalidated", `${invalidateReason}: ${diff.map((d) => d.field).join(", ")}`);
      attempt.snapshot = fresh;
      attempt.snapshot_digest = digest;
      attempt.checkout_view = view;
      attempt.native_status = view.native_status;
      attempt.approved_snapshot_digest = null;
      attempt.updated_at = this.now();
      await store.updateAttempt(attempt);
      const latest = (await store.getRequest(request.id)) ?? request;
      Object.assign(request, latest);
      await this.transition(store, request, "awaiting_approval", `${invalidateReason}: ${diff.map((d) => `${d.field} ${JSON.stringify(d.approved)} → ${JSON.stringify(d.current)}`).join("; ")}`);
    });
    throw new DomainError("terms_changed", "Checkout terms changed since the approval snapshot was taken; re-approval required", 409, {
      previous_digest: expectedDigest,
      current_digest: digest,
      changes: diff,
    });
  }

  async approve(requestId: string, principal: Principal, traceId: string): Promise<{ request: ProcurementRequest; approval: Approval; attempt: CheckoutAttempt }> {
    const request = await this.getRequest(requestId, principal);
    assertCanApprove(principal, request.organization_id);
    invariant(request.status === "awaiting_approval", "invalid_state", `Cannot approve in status ${request.status}`);
    const attempt = await this.currentAttempt(request);
    const view = await this.refreshAndCompare(request, attempt, traceId, attempt.snapshot_digest, "terms changed before approval");
    const policy = this.deps.policyFor(request.organization_id);
    const decision = evaluatePurchasePolicy(policy, {
      currency: view.currency,
      total_minor: view.totals.total_minor,
      merchant_id: attempt.merchant_id,
      category: request.product_constraints.category,
      delivery_promise: view.delivery_promise,
      delivery_deadline: request.delivery_deadline,
    });
    if (!decision.allowed) throw new DomainError("policy_violation", "Final terms violate purchasing policy", 422, decision.checks.filter((c) => !c.passed));
    invariant(view.totals.total_minor <= request.budget_minor, "over_budget", `Final total ${view.totals.total_minor} exceeds request budget ${request.budget_minor}`, 422);
    const budget = await new BudgetLedger(this.deps.driver).view(request.cost_center_id);
    invariant(budget.available_minor >= view.totals.total_minor, "insufficient_budget", `Cost centre has ${budget.available_minor} available; need ${view.totals.total_minor}`, 409);

    const now = this.deps.clock();
    const approval: Approval = {
      id: newId("apr"),
      procurement_request_id: request.id,
      checkout_attempt_id: attempt.id,
      actor_id: principal.id,
      snapshot_digest: attempt.snapshot_digest,
      snapshot: attempt.snapshot,
      approved_at: iso(now),
      expires_at: iso(new Date(now.getTime() + policy.approval_ttl_minutes * 60_000)),
      auth_context: { principal_id: principal.id, roles: principal.roles, trace_id: traceId },
      state: "active",
      invalidation_reason: null,
    };
    await this.tx(async (store) => {
      const fresh = await store.getRequest(request.id);
      invariant(fresh && fresh.status === "awaiting_approval", "invalid_state", "Request state changed during approval");
      const active = await store.activeApproval(request.id);
      if (active) await store.updateApprovalState(active.id, "invalidated", "superseded by new approval");
      await store.insertApproval(approval);
      attempt.approved_snapshot_digest = attempt.snapshot_digest;
      attempt.updated_at = iso(now);
      await store.updateAttempt(attempt);
      await this.transition(store, request, "approved", `approved by ${principal.id}; digest ${approval.snapshot_digest}`);
    });
    return { request, approval, attempt };
  }

  // -------------------------------------------------------------------------
  // Execution: reserve budget + enqueue completion atomically
  // -------------------------------------------------------------------------
  async execute(requestId: string, principal: Principal, traceId: string): Promise<{ request: ProcurementRequest; attempt: CheckoutAttempt; reservation: BudgetReservation; outbox: OutboxMessage; already_enqueued: boolean }> {
    const request = await this.getRequest(requestId, principal);
    assertCanPurchase(principal, request.organization_id);
    const attempt = await this.currentAttempt(request);

    // Idempotent replay: execution already recorded for this attempt.
    const existing = await this.store.getOutbox("execute_checkout", attempt.id);
    if (existing) {
      const reservation = await this.store.getReservationByReference(attempt.id);
      invariant(reservation, "inconsistent_state", "Execution recorded without a reservation", 500);
      return { request, attempt, reservation, outbox: existing, already_enqueued: true };
    }

    invariant(request.status === "approved", "invalid_state", `Cannot execute in status ${request.status}`);
    const approval = await this.store.activeApproval(request.id);
    invariant(approval && approval.checkout_attempt_id === attempt.id, "no_active_approval", "No active approval for the selected checkout");
    if (new Date(approval.expires_at).getTime() <= this.deps.clock().getTime()) {
      await this.tx(async (store) => {
        await store.updateApprovalState(approval.id, "invalidated", "approval expired");
        await this.transition(store, request, "awaiting_approval", "approval expired before execution");
      });
      throw new DomainError("approval_expired", `Approval expired at ${approval.expires_at}`, 409);
    }
    // Terms must still match what was approved (merchant may have changed the checkout).
    await this.refreshAndCompare(request, attempt, traceId, approval.snapshot_digest, "terms changed after approval");

    const now = this.now();
    const result = await this.tx(async (store, tx) => {
      const fresh = await store.getRequest(request.id);
      invariant(fresh && fresh.status === "approved", "invalid_state", "Request state changed during execution");
      const stillActive = await store.activeApproval(request.id);
      invariant(stillActive && stillActive.id === approval.id, "no_active_approval", "Approval was invalidated concurrently");
      const ledger = new BudgetLedger(tx);
      const reservation = await ledger.reserve({
        cost_center_id: request.cost_center_id,
        procurement_request_id: request.id,
        execution_reference: attempt.id,
        amount_minor: attempt.snapshot.totals.total_minor,
        currency: attempt.snapshot.currency,
        now,
      });
      const outbox: OutboxMessage = {
        id: newId("obx"),
        kind: "execute_checkout",
        aggregate_id: attempt.id,
        payload: { attempt_id: attempt.id, procurement_request_id: request.id, approval_id: approval.id, trace_id: traceId },
        available_at: now,
        claimed_at: null,
        claimed_by: null,
        completed_at: null,
        attempts: 0,
        last_error: null,
        created_at: now,
      };
      await store.insertOutbox(outbox);
      await store.updateApprovalState(approval.id, "consumed", null);
      Object.assign(request, fresh);
      await this.transition(store, request, "completing", `budget ${reservation.amount_minor} ${reservation.currency} reserved (${reservation.id}); completion enqueued`);
      return { reservation, outbox };
    });
    return { request, attempt, reservation: result.reservation, outbox: result.outbox, already_enqueued: false };
  }

  // -------------------------------------------------------------------------
  // Worker handlers
  // -------------------------------------------------------------------------
  async runExecution(attemptId: string, traceId: string): Promise<CompletionOutcome["kind"]> {
    const attempt = await this.store.getAttempt(attemptId);
    if (!attempt) throw new DomainError("not_found", `attempt ${attemptId} not found`, 404);
    if (attempt.completion_state === "ordered" || attempt.completion_state === "rejected") return attempt.completion_state;
    const request = await this.store.getRequest(attempt.procurement_request_id);
    if (!request) throw new DomainError("not_found", "request not found", 404);
    const buyer = await this.store.getBuyer(request.buyer_id);
    const destination = this.destination(request.destination_id);

    if (attempt.completion_state === "pending") {
      await this.tx(async (store) => {
        assertCompletionTransition(attempt.completion_state, "in_flight");
        assertPaymentTransition(attempt.payment_state, "pending");
        attempt.completion_state = "in_flight";
        attempt.payment_state = "pending";
        attempt.updated_at = this.now();
        await store.updateAttempt(attempt);
      });
    }
    // If we crashed after this point last time, the same idempotency key is re-sent; the merchant deduplicates.
    const adapter = this.adapterFor(attempt.merchant_id);
    let outcome: CompletionOutcome;
    try {
      outcome = await adapter.complete({
        attempt_id: attempt.id,
        procurement_request_id: request.id,
        merchant_id: attempt.merchant_id,
        native_checkout_id: attempt.native_checkout_id,
        idempotency_key: attempt.idempotency_key,
        trace_id: traceId,
        payment_credential_ref: this.deps.paymentCredentialRef,
        buyer: { name: buyer?.name ?? destination.contact_name, email: buyer?.email ?? destination.contact_email, phone: destination.contact_phone },
        simulation: request.simulation,
      });
    } catch (err) {
      outcome = { kind: "unknown", error: err instanceof Error ? err.message : String(err) };
    }
    await this.applyOutcome(attempt, request, outcome, traceId);
    return outcome.kind;
  }

  private async applyOutcome(attempt: CheckoutAttempt, request: ProcurementRequest, outcome: CompletionOutcome, traceId: string): Promise<void> {
    const now = this.now();
    await this.tx(async (store, tx) => {
      const ledger = new BudgetLedger(tx);
      const current = (await store.getAttempt(attempt.id)) ?? attempt;
      if (current.completion_state === "ordered" || current.completion_state === "rejected") return; // already resolved
      const fresh = (await store.getRequest(request.id)) ?? request;
      Object.assign(request, fresh);

      if (outcome.kind === "ordered") {
        assertCompletionTransition(current.completion_state, "ordered");
        current.completion_state = "ordered";
        current.payment_state = outcome.payment_state;
        current.native_order_id = outcome.native_order_id;
        current.native_status = outcome.view.native_status;
        current.checkout_view = outcome.view;
        current.last_error = null;
        current.updated_at = now;
        await store.updateAttempt(current);
        await ledger.commit(current.id, now);
        const approval = (await store.listApprovals(request.id)).filter((a) => a.checkout_attempt_id === current.id).at(-1);
        const receipt: Receipt = {
          id: newId("rcpt"),
          procurement_request_id: request.id,
          checkout_attempt_id: current.id,
          approval_id: approval?.id ?? "",
          order_references: {
            merchant_id: current.merchant_id,
            protocol: current.protocol,
            native_checkout_id: current.native_checkout_id,
            native_order_id: outcome.native_order_id,
            permalink_url: outcome.view.terms["order_permalink"] ?? null,
          },
          payment_evidence: { payment_state: outcome.payment_state, handler: outcome.view.payment_handler?.id ?? null, reference: outcome.view.terms["payment_reference"] ?? null },
          final_totals: { ...outcome.view.totals, currency: outcome.view.currency },
          created_at: now,
        };
        if (!(await store.getReceipt(request.id))) await store.insertReceipt(receipt);
        await this.transition(store, request, "ordered", `order ${outcome.native_order_id} confirmed by ${current.merchant_id}`);
      } else if (outcome.kind === "rejected") {
        assertCompletionTransition(current.completion_state, "rejected");
        current.completion_state = "rejected";
        current.payment_state = outcome.payment_state;
        current.last_error = `${outcome.code}: ${outcome.reason}`;
        if (outcome.view) {
          current.checkout_view = outcome.view;
          current.native_status = outcome.view.native_status;
        }
        current.updated_at = now;
        await store.updateAttempt(current);
        await ledger.release(current.id, now);
        await this.transition(store, request, "rejected", `merchant rejected completion (${outcome.code}: ${outcome.reason}); payment ${outcome.payment_state}`);
      } else {
        assertCompletionTransition(current.completion_state, "outcome_unknown");
        current.completion_state = "outcome_unknown";
        current.payment_state = "outcome_unknown";
        current.last_error = outcome.error;
        current.updated_at = now;
        await store.updateAttempt(current);
        const delay = this.deps.reconcileDelayMs ?? 2000;
        const existing = await store.getOutbox("reconcile_attempt", current.id);
        if (!existing) {
          await store.insertOutbox({
            id: newId("obx"),
            kind: "reconcile_attempt",
            aggregate_id: current.id,
            payload: { attempt_id: current.id, procurement_request_id: request.id, trace_id: traceId, probes: 0 },
            available_at: iso(new Date(this.deps.clock().getTime() + delay)),
            claimed_at: null,
            claimed_by: null,
            completed_at: null,
            attempts: 0,
            last_error: null,
            created_at: now,
          });
        }
        if (request.status !== "reconciliation_required") {
          await this.transition(store, request, "reconciliation_required", `completion outcome unknown: ${outcome.error}`);
        }
      }
    });
  }

  /**
   * Recovery: ask the merchant what actually happened (native Get Checkout).
   * Returns true when the attempt is resolved; false when it must be probed again.
   */
  async runReconciliation(attemptId: string, traceId: string, probes: number): Promise<boolean> {
    const attempt = await this.store.getAttempt(attemptId);
    if (!attempt) throw new DomainError("not_found", `attempt ${attemptId} not found`, 404);
    if (attempt.completion_state === "ordered" || attempt.completion_state === "rejected") return true;
    const request = await this.store.getRequest(attempt.procurement_request_id);
    if (!request) throw new DomainError("not_found", "request not found", 404);
    const adapter = this.adapterFor(attempt.merchant_id);
    const result = await adapter.reconcile(attempt.merchant_id, attempt.native_checkout_id, traceId);
    attempt.last_reconciled_at = this.now();
    await this.store.updateAttempt(attempt);
    this.deps.logger.info("reconciliation_probe", { attempt_id: attempt.id, resolution: result.resolution, probes });

    if (result.resolution === "ordered" && result.native_order_id && result.view) {
      await this.applyOutcome(attempt, request, { kind: "ordered", native_order_id: result.native_order_id, payment_state: "succeeded", view: result.view }, traceId);
      return true;
    }
    if (result.resolution === "rejected" || result.resolution === "canceled") {
      await this.applyOutcome(attempt, request, { kind: "rejected", code: result.resolution, reason: result.detail, payment_state: result.payment_state, view: result.view }, traceId);
      return true;
    }
    // Still unknown. Only after repeated probes do we re-send the *identical*
    // complete call (same idempotency key) — the merchant must deduplicate.
    const retryAfter = this.deps.retryCompleteAfterProbes ?? 2;
    if (probes + 1 >= retryAfter) {
      this.deps.logger.warn("retrying_identical_completion", { attempt_id: attempt.id, idempotency_key: attempt.idempotency_key });
      const kind = await this.runExecution(attempt.id, traceId);
      return kind !== "unknown";
    }
    return false;
  }

  /** Expire stale approvals and quotes. */
  async expireStale(): Promise<{ approvals: number; requests: number }> {
    const nowMs = this.deps.clock().getTime();
    let approvals = 0;
    let requests = 0;
    for (const request of await this.store.listRequestsByStatus("approved")) {
      const approval = await this.store.activeApproval(request.id);
      if (approval && new Date(approval.expires_at).getTime() <= nowMs) {
        await this.tx(async (store) => {
          await store.updateApprovalState(approval.id, "invalidated", "approval expired");
          await this.transition(store, request, "awaiting_approval", "approval expired");
        });
        approvals++;
      }
    }
    for (const status of ["comparing", "awaiting_approval"] as RequestStatus[]) {
      for (const request of await this.store.listRequestsByStatus(status)) {
        const quotes = await this.store.listQuotes(request.id);
        const eligibleLive = quotes.some((q) => q.eligibility?.eligible && new Date(q.expires_at).getTime() > nowMs);
        if (quotes.length > 0 && !eligibleLive && status === "awaiting_approval") {
          await this.tx(async (store) => {
            const active = await store.activeApproval(request.id);
            if (active) await store.updateApprovalState(active.id, "invalidated", "quote expired");
            await this.transition(store, request, "expired", "all eligible quotes expired");
          });
          requests++;
        }
      }
    }
    return { approvals, requests };
  }

  // -------------------------------------------------------------------------
  // Read models
  // -------------------------------------------------------------------------
  async timeline(requestId: string, principal: Principal): Promise<Timeline> {
    const request = await this.getRequest(requestId, principal);
    const [workflow_events, protocol_events, supplier_tasks, quotes, attempts, approvals, reservations, receipt] = await Promise.all([
      this.store.listWorkflowEvents(request.id),
      this.store.listProtocolEvents(request.id),
      this.store.listSupplierTasks(request.id),
      this.store.listQuotes(request.id),
      this.store.listAttempts(request.id),
      this.store.listApprovals(request.id),
      this.store.listReservations(request.id),
      this.store.getReceipt(request.id),
    ]);
    let budget: BudgetView | null = null;
    if (request.cost_center_id) {
      try {
        budget = await new BudgetLedger(this.deps.driver).view(request.cost_center_id);
      } catch {
        budget = null;
      }
    }
    return { request, workflow_events, protocol_events, supplier_tasks, quotes, attempts, approvals, reservations, receipt: receipt ?? null, budget };
  }

  async receipt(requestId: string, principal: Principal): Promise<Receipt> {
    const request = await this.getRequest(requestId, principal);
    const r = await this.store.getReceipt(request.id);
    if (!r) throw new DomainError("receipt_not_ready", `No receipt: request is ${request.status}`, TERMINAL_STATUSES.includes(request.status) ? 404 : 409);
    return r;
  }

  async cancel(requestId: string, principal: Principal, reason: string): Promise<ProcurementRequest> {
    const request = await this.getRequest(requestId, principal);
    await this.tx(async (store) => {
      const active = await store.activeApproval(request.id);
      if (active) await store.updateApprovalState(active.id, "invalidated", `cancelled: ${reason}`);
      await this.transition(store, request, "cancelled", reason);
    });
    return request;
  }
}
