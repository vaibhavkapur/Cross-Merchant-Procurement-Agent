import type { Minor } from "./money.ts";
import type { MerchantProtocol, QuoteArtifact } from "@procurement/protocol-contracts";

export type RequestStatus =
  | "draft"
  | "collecting_quotes"
  | "comparing"
  | "awaiting_approval"
  | "approved"
  | "completing"
  | "ordered"
  | "reconciliation_required"
  | "rejected"
  | "expired"
  | "cancelled";

export type PaymentState = "not_started" | "pending" | "succeeded" | "failed" | "outcome_unknown";
export type CompletionState = "pending" | "in_flight" | "ordered" | "rejected" | "outcome_unknown";

export interface ProductConstraints {
  category: string;
  minimum_size_inches?: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface Destination {
  destination_id: string;
  name: string;
  line_one: string;
  line_two?: string;
  locality: string;
  region: string;
  postal_code: string;
  country: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  timezone: string;
}

/** Fixture-only knobs; every merchant/supplier simulator honours these explicitly. */
export interface SimulationFlags {
  /** Supplier IDs that should not answer before the RFQ deadline. */
  supplier_timeout?: string[];
  /** Merchant whose shipping charge increases between quotation and checkout. */
  shipping_increase?: { merchant_id: string; amount_minor: Minor };
  /** Merchant that accepts the order but never returns the completion response. */
  drop_completion_response?: string;
  /** Merchant whose payment is accepted but whose order is rejected afterwards. */
  payment_ok_order_rejected?: string;
  /** Supplier that embeds an instruction to bypass policy in its quote notes. */
  inject_policy_bypass?: string;
}

export interface ProcurementRequest {
  id: string;
  organization_id: string;
  buyer_id: string;
  cost_center_id: string;
  product_constraints: ProductConstraints;
  quantity: number;
  delivery_deadline: string;
  currency: string;
  budget_minor: Minor;
  destination_id: string;
  allowed_merchants: string[];
  status: RequestStatus;
  version: number;
  intent: IntentDraft | null;
  missing_fields: string[];
  selected_quote_id: string | null;
  simulation: SimulationFlags;
  source_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntentDraft {
  product: ProductConstraints;
  quantity: number | null;
  budget_minor: Minor | null;
  currency: string;
  delivery_deadline: string | null;
  deadline_phrase: string | null;
  destination_id: string | null;
  cost_center_id: string | null;
  allowed_merchants: string[] | null;
  clarifications: string[];
  extractor: string;
}

export interface SupplierTask {
  id: string;
  procurement_request_id: string;
  supplier_id: string;
  a2a_task_id: string | null;
  a2a_context_id: string | null;
  native_status: string;
  deadline: string;
  last_event_at: string | null;
  artifact_reference: string | null;
  error: string | null;
  created_at: string;
}

export interface ConstraintCheck {
  constraint: string;
  passed: boolean;
  detail: string;
}

export interface EligibilityResult {
  eligible: boolean;
  checks: ConstraintCheck[];
  failed: string[];
}

export interface RankingExplanation {
  rank: number | null;
  delivered_total_minor: Minor;
  delivery_buffer_hours: number | null;
  preference_score: number;
  summary: string;
}

export interface Quote {
  id: string;
  supplier_task_id: string;
  procurement_request_id: string;
  supplier_id: string;
  merchant_id: string;
  native_quote_id: string;
  items: QuoteArtifact["items"];
  subtotal_minor: Minor;
  tax_minor: Minor;
  shipping_minor: Minor;
  total_minor: Minor;
  currency: string;
  delivery_date: string | null;
  expires_at: string;
  quantity_available: number;
  eligibility: EligibilityResult | null;
  ranking: RankingExplanation | null;
  artifact: QuoteArtifact;
  created_at: string;
}

export interface CapabilitySnapshot {
  merchant_id: string;
  protocol: MerchantProtocol;
  protocol_version: string;
  endpoint: string;
  capabilities: string[];
  payment_handlers: string[];
  supports_checkout: boolean;
  discovered_at: string;
  native: unknown;
}

export interface CheckoutLineView {
  native_line_id: string;
  merchant_item_id: string;
  title: string;
  quantity: number;
  unit_minor: Minor | null;
  total_minor: Minor;
}

export interface CheckoutTotals {
  subtotal_minor: Minor;
  tax_minor: Minor;
  shipping_minor: Minor;
  fees_minor: Minor;
  total_minor: Minor;
}

export type NormalizedCheckoutStatus = "incomplete" | "ready" | "completing" | "completed" | "canceled" | "blocked";

export interface CheckoutMessage {
  type: string;
  code: string | null;
  content: string;
}

export interface CheckoutView {
  protocol: MerchantProtocol;
  protocol_version: string;
  merchant_id: string;
  native_checkout_id: string;
  native_status: string;
  normalized_status: NormalizedCheckoutStatus;
  currency: string;
  line_items: CheckoutLineView[];
  totals: CheckoutTotals;
  /** Latest promised delivery time (RFC 3339) or null when the merchant made no promise. */
  delivery_promise: string | null;
  fulfillment_option: string | null;
  payment_handler: { id: string; type: string } | null;
  native_order_id: string | null;
  messages: CheckoutMessage[];
  terms: Record<string, string>;
  native: unknown;
}

export interface CheckoutInput {
  procurement_request_id: string;
  merchant_id: string;
  quote: Quote;
  currency: string;
  destination: Destination;
  idempotency_key: string;
  trace_id: string;
  simulation: SimulationFlags;
}

export interface CompletionInput {
  attempt_id: string;
  procurement_request_id: string;
  merchant_id: string;
  native_checkout_id: string;
  idempotency_key: string;
  trace_id: string;
  /** Opaque reference to a payment credential held by the payment vault, never the credential itself. */
  payment_credential_ref: string;
  buyer: { name: string; email: string; phone: string };
  simulation: SimulationFlags;
}

export type CompletionOutcome =
  | { kind: "ordered"; native_order_id: string; payment_state: PaymentState; view: CheckoutView }
  | { kind: "rejected"; code: string; reason: string; payment_state: PaymentState; view: CheckoutView | null }
  | { kind: "unknown"; error: string };

export interface ReconciliationResult {
  resolution: "ordered" | "rejected" | "still_unknown" | "canceled";
  native_order_id: string | null;
  payment_state: PaymentState;
  detail: string;
  view: CheckoutView | null;
}

export interface CommerceAdapter {
  readonly protocol: MerchantProtocol;
  discover(merchantId: string, traceId: string): Promise<CapabilitySnapshot>;
  createCheckout(input: CheckoutInput): Promise<CheckoutView>;
  getCheckout(merchantId: string, nativeId: string, traceId: string): Promise<CheckoutView>;
  complete(input: CompletionInput): Promise<CompletionOutcome>;
  reconcile(merchantId: string, nativeCheckoutId: string, traceId: string): Promise<ReconciliationResult>;
}

export interface ApprovalSnapshot {
  procurement_request_id: string;
  request_version: number;
  merchant_id: string;
  protocol: MerchantProtocol;
  protocol_version: string;
  native_checkout_id: string;
  currency: string;
  items: Array<{ merchant_item_id: string; title: string; quantity: number; unit_minor: Minor | null; total_minor: Minor }>;
  quantity: number;
  totals: CheckoutTotals;
  destination_id: string;
  delivery_promise: string | null;
  delivery_deadline: string;
  terms: Record<string, string>;
}

export interface CheckoutAttempt {
  id: string;
  procurement_request_id: string;
  quote_id: string;
  merchant_id: string;
  protocol: MerchantProtocol;
  protocol_version: string;
  native_checkout_id: string;
  native_order_id: string | null;
  native_status: string | null;
  approved_snapshot_digest: string | null;
  idempotency_key: string;
  completion_state: CompletionState;
  payment_state: PaymentState;
  capability_snapshot: CapabilitySnapshot | null;
  checkout_view: CheckoutView;
  snapshot: ApprovalSnapshot;
  snapshot_digest: string;
  last_error: string | null;
  attempt_no: number;
  last_reconciled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Approval {
  id: string;
  procurement_request_id: string;
  checkout_attempt_id: string;
  actor_id: string;
  snapshot_digest: string;
  snapshot: ApprovalSnapshot;
  approved_at: string;
  expires_at: string;
  auth_context: Record<string, unknown>;
  state: "active" | "invalidated" | "consumed";
  invalidation_reason: string | null;
}

export interface BudgetReservation {
  id: string;
  cost_center_id: string;
  procurement_request_id: string;
  execution_reference: string;
  amount_minor: Minor;
  currency: string;
  state: "active" | "committed" | "released";
  created_at: string;
  resolved_at: string | null;
}

export interface CostCenter {
  id: string;
  organization_id: string;
  name: string;
  currency: string;
  allocated_minor: Minor;
  committed_minor: Minor;
}

export interface Receipt {
  id: string;
  procurement_request_id: string;
  checkout_attempt_id: string;
  approval_id: string;
  order_references: { merchant_id: string; protocol: MerchantProtocol; native_checkout_id: string; native_order_id: string; permalink_url: string | null };
  payment_evidence: { payment_state: PaymentState; handler: string | null; reference: string | null };
  final_totals: CheckoutTotals & { currency: string };
  created_at: string;
}

export interface ProtocolEvent {
  id: string;
  procurement_request_id: string | null;
  trace_id: string;
  protocol: "mcp" | "a2a" | "ucp" | "acp" | "app";
  direction: "outbound" | "inbound" | "internal";
  operation: string;
  version: string | null;
  counterparty: string | null;
  status: string | null;
  payload: unknown;
  created_at: string;
}

export interface WorkflowEvent {
  id: string;
  procurement_request_id: string;
  from_status: RequestStatus | null;
  to_status: RequestStatus;
  reason: string;
  created_at: string;
}

export interface OutboxMessage {
  id: string;
  kind: "execute_checkout" | "reconcile_attempt";
  aggregate_id: string;
  payload: Record<string, unknown>;
  available_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  completed_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export interface Merchant {
  id: string;
  name: string;
  protocol: MerchantProtocol;
  base_url: string;
  /** Approved discovery/document endpoint for SSRF allow-listing. */
  discovery_url: string;
  api_key_env: string;
}

export interface Supplier {
  id: string;
  name: string;
  agent_url: string;
  merchant_id: string;
}
