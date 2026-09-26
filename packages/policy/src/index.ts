import type { MerchantProtocol } from "@procurement/protocol-contracts";

// ---------------------------------------------------------------------------
// Principals & permissions
// ---------------------------------------------------------------------------
export type Role = "requester" | "approver" | "auditor" | "service";

export interface Principal {
  id: string;
  organization_id: string;
  name: string;
  roles: Role[];
  /** Read access to inventory/policy does not imply purchasing authority. */
  can_purchase: boolean;
}

export class PolicyError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status = 403, details?: unknown) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function hasRole(p: Principal, role: Role): boolean {
  return p.roles.includes(role);
}

export function assertCanRead(p: Principal, organizationId: string): void {
  if (p.organization_id !== organizationId) throw new PolicyError("forbidden_org", "Principal does not belong to this organization");
}

export function assertCanRequest(p: Principal, organizationId: string): void {
  assertCanRead(p, organizationId);
  if (!hasRole(p, "requester") && !hasRole(p, "approver")) throw new PolicyError("forbidden_role", "Principal may not create procurement requests");
}

export function assertCanApprove(p: Principal, organizationId: string): void {
  assertCanRead(p, organizationId);
  if (!hasRole(p, "approver")) throw new PolicyError("forbidden_role", "Principal is not an approver");
}

export function assertCanPurchase(p: Principal, organizationId: string): void {
  assertCanRead(p, organizationId);
  if (!p.can_purchase) throw new PolicyError("forbidden_purchase", "Principal has read access but no purchasing authority");
}

// ---------------------------------------------------------------------------
// Purchasing policy
// ---------------------------------------------------------------------------
export interface ApprovedVendor {
  merchant_id: string;
  name: string;
  protocol: MerchantProtocol;
  categories: string[];
  /** Ordered preference used only as a tie-breaker in ranking. */
  preference_rank: number;
}

export interface PurchasingPolicy {
  organization_id: string;
  currency: string;
  /** Hard cap for a single purchase regardless of budget. */
  max_single_purchase_minor: number;
  /** Purchases above this always need an approver (all purchases in this system do; kept for policy fidelity). */
  approval_required_above_minor: number;
  allowed_categories: string[];
  /** Quote must promise delivery on or before the request deadline. */
  require_delivery_by_deadline: boolean;
  /** Minimum remaining quote validity at approval time (minutes). */
  min_quote_validity_minutes: number;
  approval_ttl_minutes: number;
  approved_vendors: ApprovedVendor[];
}

export interface PolicyCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface PolicyDecision {
  allowed: boolean;
  checks: PolicyCheck[];
}

export function approvedMerchantIds(policy: PurchasingPolicy, category?: string): string[] {
  return policy.approved_vendors
    .filter((v) => !category || v.categories.includes(category))
    .sort((a, b) => a.preference_rank - b.preference_rank)
    .map((v) => v.merchant_id);
}

/** Evaluate request-level policy (before any quotes are solicited). */
export function evaluateRequestPolicy(
  policy: PurchasingPolicy,
  request: { currency: string; budget_minor: number; quantity: number; category: string; allowed_merchants: string[] },
): PolicyDecision {
  const checks: PolicyCheck[] = [];
  checks.push({
    rule: "currency",
    passed: request.currency === policy.currency,
    detail: `request currency ${request.currency} vs policy ${policy.currency}`,
  });
  checks.push({
    rule: "max_single_purchase",
    passed: request.budget_minor <= policy.max_single_purchase_minor,
    detail: `budget ${request.budget_minor} ≤ cap ${policy.max_single_purchase_minor}`,
  });
  checks.push({
    rule: "allowed_category",
    passed: policy.allowed_categories.includes(request.category),
    detail: `category "${request.category}" ${policy.allowed_categories.includes(request.category) ? "is" : "is not"} allowed`,
  });
  checks.push({ rule: "positive_quantity", passed: Number.isInteger(request.quantity) && request.quantity > 0, detail: `quantity ${request.quantity}` });
  const approved = new Set(approvedMerchantIds(policy, request.category));
  const unapproved = request.allowed_merchants.filter((m) => !approved.has(m));
  checks.push({
    rule: "approved_vendors_only",
    passed: unapproved.length === 0,
    detail: unapproved.length ? `merchants not approved for ${request.category}: ${unapproved.join(", ")}` : "all requested merchants are approved",
  });
  return { allowed: checks.every((c) => c.passed), checks };
}

/** Evaluate the final terms against policy right before an approval is accepted. */
export function evaluatePurchasePolicy(
  policy: PurchasingPolicy,
  terms: { currency: string; total_minor: number; merchant_id: string; category: string; delivery_promise: string | null; delivery_deadline: string },
): PolicyDecision {
  const checks: PolicyCheck[] = [];
  checks.push({ rule: "currency", passed: terms.currency === policy.currency, detail: `${terms.currency} vs ${policy.currency}` });
  checks.push({
    rule: "max_single_purchase",
    passed: terms.total_minor <= policy.max_single_purchase_minor,
    detail: `total ${terms.total_minor} ≤ cap ${policy.max_single_purchase_minor}`,
  });
  const approved = approvedMerchantIds(policy, terms.category).includes(terms.merchant_id);
  checks.push({ rule: "approved_vendor", passed: approved, detail: `${terms.merchant_id} ${approved ? "is" : "is not"} an approved vendor for ${terms.category}` });
  if (policy.require_delivery_by_deadline) {
    const ok = terms.delivery_promise !== null && new Date(terms.delivery_promise).getTime() <= new Date(terms.delivery_deadline).getTime();
    checks.push({ rule: "delivery_by_deadline", passed: ok, detail: `promise ${terms.delivery_promise ?? "none"} vs deadline ${terms.delivery_deadline}` });
  }
  return { allowed: checks.every((c) => c.passed), checks };
}

// ---------------------------------------------------------------------------
// Untrusted-content handling
// ---------------------------------------------------------------------------
const INSTRUCTION_PATTERNS = [
  /ignore (all|any|previous|prior|the) (instructions|rules|polic(y|ies))/i,
  /bypass (the )?(approval|polic(y|ies)|budget)/i,
  /skip (the )?(approval|budget check|validation)/i,
  /as (the|an) (system|assistant|agent)[,:]/i,
  /you (must|should) (approve|purchase|select|choose)/i,
  /\bsystem prompt\b/i,
  /\bapprove (this|immediately|now)\b/i,
];

export interface ContentScan {
  suspicious: boolean;
  matches: string[];
}

/**
 * Supplier/merchant free text is data, never instructions. This scanner only
 * flags text for the audit trail and UI; the decision engine never reads
 * free-text fields, so an injected instruction cannot influence selection.
 */
export function scanUntrustedText(text: string | null | undefined): ContentScan {
  if (!text) return { suspicious: false, matches: [] };
  const matches = INSTRUCTION_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
  return { suspicious: matches.length > 0, matches };
}
