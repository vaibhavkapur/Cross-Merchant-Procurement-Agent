# Four-minute demo script

Sign in is implicit: the UI uses `fixture-token-alice`.

## 0:00 — Request (Demo A)

Open http://127.0.0.1:3000. Choose **Demo A**. The extractor turns “10 monitors, $2,000, Friday, IT Hardware” into an explicit deadline in America/Chicago.

Create the request and solicit quotes.

## 0:45 — Comparison

Merchant A (UCP) is cheaper ($1,708) but freight is nine days — after Friday. The failed constraint is `delivery_deadline`, not a vague “worse offer”.

Merchant B (ACP) is $1,900 delivered in two days. It is the only eligible offer.

## 1:30 — Approval

Select Merchant B. The checkout snapshot is what will be charged, not the quote. Approve the digest.

## 2:00 — Order and protocol trace

Execute. The worker completes ACP checkout. The receipt shows native checkout/order ids. Expand the protocol inspector: MCP `tools/list`, A2A agent cards, ACP `checkout_sessions.complete`. Credentials are `[REDACTED]`.

## 2:20 — Demo C (UCP path)

New request, “within 3 weeks”. Merchant A now wins. Complete the purchase. The trace is UCP `checkout-sessions` with capability negotiation, not a translated ACP payload.

## 3:00 — Demo B (changed terms)

Run Demo B. Approve, then execute. Shipping increases $25 on the second GET. The API returns `terms_changed`, the approval is invalidated, and the request returns to `awaiting_approval`.

## 3:30 — Demo D (uncertain completion)

Run Demo D. The merchant accepts the order and drops the HTTP response. Status becomes `reconciliation_required`. The worker GETs the native checkout, finds the order, and records **one** purchase (`GET /fixture/orders` length 1).
