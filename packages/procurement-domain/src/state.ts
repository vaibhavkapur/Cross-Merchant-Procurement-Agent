import type { CompletionState, PaymentState, RequestStatus } from "./types.ts";
import { DomainError } from "./util.ts";

/**
 * Application workflow state machine (plan §14):
 *
 *   draft → collecting_quotes → comparing → awaiting_approval
 *   awaiting_approval → approved → completing → ordered
 *   completing → reconciliation_required → ordered | rejected
 *   awaiting_approval → expired | cancelled
 *   approved → awaiting_approval   [checkout terms changed]
 */
const REQUEST_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  draft: ["draft", "collecting_quotes", "cancelled"],
  collecting_quotes: ["comparing", "collecting_quotes", "rejected", "cancelled"],
  comparing: ["awaiting_approval", "comparing", "rejected", "cancelled"],
  awaiting_approval: ["approved", "awaiting_approval", "expired", "cancelled", "comparing"],
  approved: ["completing", "awaiting_approval", "cancelled"],
  completing: ["ordered", "reconciliation_required", "rejected"],
  reconciliation_required: ["ordered", "rejected", "reconciliation_required"],
  ordered: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError("invalid_transition", `cannot move procurement request from '${from}' to '${to}'`, 409);
  }
}

export const TERMINAL_STATUSES: readonly RequestStatus[] = ["ordered", "rejected", "expired", "cancelled"];

/** Payment tracked separately: not_started → pending → succeeded | failed | outcome_unknown */
const PAYMENT_TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  not_started: ["pending", "not_started"],
  pending: ["succeeded", "failed", "outcome_unknown", "pending"],
  outcome_unknown: ["succeeded", "failed", "outcome_unknown"],
  succeeded: ["succeeded"],
  failed: ["failed"],
};

export function assertPaymentTransition(from: PaymentState, to: PaymentState): void {
  if (!PAYMENT_TRANSITIONS[from].includes(to)) {
    throw new DomainError("invalid_payment_transition", `payment state cannot move from '${from}' to '${to}'`, 409);
  }
}

const COMPLETION_TRANSITIONS: Record<CompletionState, readonly CompletionState[]> = {
  pending: ["in_flight", "pending"],
  in_flight: ["ordered", "rejected", "outcome_unknown"],
  outcome_unknown: ["ordered", "rejected", "outcome_unknown"],
  ordered: ["ordered"],
  rejected: ["rejected"],
};

export function assertCompletionTransition(from: CompletionState, to: CompletionState): void {
  if (!COMPLETION_TRANSITIONS[from].includes(to)) {
    throw new DomainError("invalid_completion_transition", `completion state cannot move from '${from}' to '${to}'`, 409);
  }
}
