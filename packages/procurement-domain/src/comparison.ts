import type { QuoteArtifact } from "@procurement/protocol-contracts";
import { addMinor, sameCurrency, type Minor } from "./money.ts";
import type { CapabilitySnapshot, ConstraintCheck, EligibilityResult, ProductConstraints, RankingExplanation } from "./types.ts";

export interface RankingPreference {
  /** Ordered ranking criteria; ties broken deterministically by merchant then quote id. */
  criteria: Array<"delivered_cost" | "delivery_buffer" | "preferred_merchant">;
  preferred_merchants: string[];
}

export const DEFAULT_RANKING: RankingPreference = {
  criteria: ["delivered_cost", "delivery_buffer", "preferred_merchant"],
  preferred_merchants: [],
};

export interface ComparisonRequest {
  product: ProductConstraints;
  quantity: number;
  currency: string;
  budget_minor: Minor;
  delivery_deadline: string;
  allowed_merchants: string[];
}

export interface ComparisonContext {
  request: ComparisonRequest;
  /** Vendors approved by purchasing policy for this category. */
  approved_merchants: string[];
  capabilities: Record<string, CapabilitySnapshot | undefined>;
  now: Date;
  ranking?: RankingPreference;
  /** Minimum remaining validity of a quote at comparison time. */
  min_quote_validity_ms?: number;
}

export interface QuoteCandidate {
  quote_id: string;
  artifact: QuoteArtifact;
}

export interface ComparisonOutcome {
  quote_id: string;
  eligibility: EligibilityResult;
  ranking: RankingExplanation;
}

function check(constraint: string, passed: boolean, detail: string): ConstraintCheck {
  return { constraint, passed, detail };
}

export function evaluateEligibility(candidate: QuoteCandidate, ctx: ComparisonContext): EligibilityResult {
  const { artifact: q } = candidate;
  const { request } = ctx;
  const checks: ConstraintCheck[] = [];

  // 1. Required product characteristics
  const items = q.items;
  const categoryOk = items.every((i) => String(i.attributes["category"] ?? "").toLowerCase() === request.product.category.toLowerCase());
  checks.push(check("product_category", categoryOk, categoryOk ? `all items are '${request.product.category}'` : `an item is not in category '${request.product.category}'`));
  if (request.product.minimum_size_inches !== undefined) {
    const sizes = items.map((i) => i.attributes["size_inches"]);
    const known = sizes.every((s) => typeof s === "number");
    const ok = known && sizes.every((s) => (s as number) >= request.product.minimum_size_inches!);
    checks.push(
      check(
        "minimum_size_inches",
        ok,
        !known
          ? "item size not declared by supplier (unknown is not a pass)"
          : ok
            ? `all items ≥ ${request.product.minimum_size_inches}"`
            : `item size ${sizes.join(",")}" below required ${request.product.minimum_size_inches}"`,
      ),
    );
  }
  for (const [k, v] of Object.entries(request.product.attributes ?? {})) {
    const ok = items.every((i) => i.attributes[k] === v);
    checks.push(check(`attribute:${k}`, ok, ok ? `${k}=${String(v)}` : `${k} does not equal ${String(v)} on every item`));
  }

  // 2. Sufficient stock and quantity match
  const quoted = items.reduce((n, i) => n + i.quantity, 0);
  const stockOk = q.quantity_available >= request.quantity && quoted === request.quantity;
  checks.push(
    check(
      "sufficient_stock",
      stockOk,
      stockOk ? `${q.quantity_available} available, ${quoted} quoted` : `need ${request.quantity}, quoted ${quoted}, available ${q.quantity_available}`,
    ),
  );

  // 3. Permitted merchant (request allow-list ∩ policy-approved vendors)
  const merchantId = q.merchant.merchant_id;
  const permitted = request.allowed_merchants.includes(merchantId) && ctx.approved_merchants.includes(merchantId);
  checks.push(
    check(
      "permitted_merchant",
      permitted,
      permitted
        ? `${merchantId} is allowed by request and approved by policy`
        : !request.allowed_merchants.includes(merchantId)
          ? `${merchantId} is not in the request's allowed merchants`
          : `${merchantId} is not an approved vendor for this category`,
    ),
  );

  // 4. Delivery deadline — missing information is unknown, not an implied promise
  const deadline = new Date(request.delivery_deadline);
  if (q.delivery.promised_by === null) {
    checks.push(check("delivery_deadline", false, "supplier did not promise a delivery date"));
  } else {
    const promised = new Date(q.delivery.promised_by);
    const ok = promised.getTime() <= deadline.getTime();
    checks.push(
      check(
        "delivery_deadline",
        ok,
        ok
          ? `promised ${q.delivery.promised_by} is before deadline ${request.delivery_deadline}`
          : `promised ${q.delivery.promised_by} is after deadline ${request.delivery_deadline}`,
      ),
    );
  }

  // 5. Unexpired quote
  const minValidity = ctx.min_quote_validity_ms ?? 0;
  const expires = new Date(q.expires_at).getTime();
  const unexpired = expires - ctx.now.getTime() > minValidity;
  checks.push(check("quote_unexpired", unexpired, unexpired ? `valid until ${q.expires_at}` : `quote expired or expires within ${minValidity / 1000}s (${q.expires_at})`));

  // 6. Currency + delivered total within budget (and arithmetically consistent)
  const currencyOk = sameCurrency(q.price.currency, request.currency);
  checks.push(check("currency", currencyOk, currencyOk ? q.price.currency : `quote currency ${q.price.currency} ≠ ${request.currency}`));
  let consistent = false;
  try {
    consistent = addMinor(q.price.subtotal_minor, q.price.tax_minor, q.price.shipping_minor) === q.price.total_minor;
  } catch {
    consistent = false;
  }
  checks.push(check("price_components_consistent", consistent, consistent ? "subtotal + tax + shipping = total" : "price components do not add up to total"));
  const withinBudget = q.price.total_minor <= request.budget_minor;
  checks.push(
    check(
      "within_budget",
      withinBudget,
      withinBudget
        ? `delivered total ${q.price.total_minor} ≤ budget ${request.budget_minor}`
        : `delivered total ${q.price.total_minor} exceeds budget ${request.budget_minor}`,
    ),
  );

  // 7. Supported checkout and payment path (from merchant capability discovery)
  const cap = ctx.capabilities[merchantId];
  const pathOk = !!cap && cap.supports_checkout && cap.payment_handlers.length > 0 && cap.protocol === q.merchant.protocol;
  checks.push(
    check(
      "supported_checkout_path",
      pathOk,
      !cap
        ? `no capability snapshot for ${merchantId}`
        : !cap.supports_checkout
          ? `${merchantId} does not advertise a supported checkout capability`
          : cap.payment_handlers.length === 0
            ? `${merchantId} advertises no payment handler`
            : cap.protocol !== q.merchant.protocol
              ? `quote references ${q.merchant.protocol} but merchant discovered as ${cap.protocol}`
              : `${cap.protocol} ${cap.protocol_version} checkout with handlers ${cap.payment_handlers.join(",")}`,
    ),
  );

  const failed = checks.filter((c) => !c.passed).map((c) => c.constraint);
  return { eligible: failed.length === 0, checks, failed };
}

function bufferHours(deadline: string, promised: string | null): number | null {
  if (!promised) return null;
  return (new Date(deadline).getTime() - new Date(promised).getTime()) / 3_600_000;
}

/** Reject ineligible offers first, then rank the eligible ones deterministically. */
export function compareQuotes(candidates: QuoteCandidate[], ctx: ComparisonContext): ComparisonOutcome[] {
  const ranking = ctx.ranking ?? DEFAULT_RANKING;
  const evaluated = candidates.map((c) => {
    const eligibility = evaluateEligibility(c, ctx);
    const buffer = bufferHours(ctx.request.delivery_deadline, c.artifact.delivery.promised_by);
    const preference = ranking.preferred_merchants.includes(c.artifact.merchant.merchant_id) ? 1 : 0;
    return { c, eligibility, buffer, preference };
  });

  const eligible = evaluated.filter((e) => e.eligibility.eligible);
  eligible.sort((a, b) => {
    for (const criterion of ranking.criteria) {
      let d = 0;
      if (criterion === "delivered_cost") d = a.c.artifact.price.total_minor - b.c.artifact.price.total_minor;
      else if (criterion === "delivery_buffer") d = (b.buffer ?? -Infinity) - (a.buffer ?? -Infinity);
      else if (criterion === "preferred_merchant") d = b.preference - a.preference;
      if (d !== 0) return d;
    }
    const m = a.c.artifact.merchant.merchant_id.localeCompare(b.c.artifact.merchant.merchant_id);
    return m !== 0 ? m : a.c.quote_id.localeCompare(b.c.quote_id);
  });
  const rankOf = new Map(eligible.map((e, i) => [e.c.quote_id, i + 1]));

  return evaluated.map(({ c, eligibility, buffer, preference }) => {
    const rank = rankOf.get(c.quote_id) ?? null;
    const summary = eligibility.eligible
      ? `Rank ${rank}: delivered ${c.artifact.price.total_minor} ${c.artifact.price.currency}, arrives ${buffer !== null ? buffer.toFixed(1) + "h before deadline" : "at an unknown time"}${preference ? ", preferred merchant" : ""}.`
      : `Ineligible: ${eligibility.checks
          .filter((k) => !k.passed)
          .map((k) => `${k.constraint} — ${k.detail}`)
          .join("; ")}`;
    return {
      quote_id: c.quote_id,
      eligibility,
      ranking: {
        rank,
        delivered_total_minor: c.artifact.price.total_minor,
        delivery_buffer_hours: buffer,
        preference_score: preference,
        summary,
      },
    };
  });
}
