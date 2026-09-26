# Cross-Merchant Procurement Agent — Development Plan

## 1. Project summary

Build a **procurement agent that compares suppliers and purchases through different commerce protocols**.

Example request:

> “Buy 10 monitors for our office, spend no more than $2,000 including delivery, and have them arrive before Friday.”

The system should:

- turn the request into explicit purchasing constraints
- read company inventory and purchasing policy
- request quotes from independent supplier agents
- compare price, stock, delivery, and commercial terms
- create a checkout through either UCP or ACP
- obtain approval for the exact purchase
- complete one order and track its outcome
- explain its decisions with a protocol trace and receipt

The core product is **a procurement workflow with protocol adapters, deterministic controls, and recoverable checkout execution**.

Planning baseline: **25 September 2026**. Examples below are proposed application models, not official protocol payloads.

---

## 2. Why this project is compelling

Your earlier checkout project provides a foundation in merchant adapters, approvals, and payment routing. This project adds independently running agents and standards-based commerce integration.

It demonstrates four different integration responsibilities:

- internal business tools
- collaboration with external agents
- merchant capability discovery
- checkout and order management

The engineering challenge is preserving the buyer's requirements as information moves across these boundaries. A cheaper quote may fail a delivery constraint. A successful payment request may have an unknown order outcome. Those situations should be visible and recoverable.

---

## 3. Protocol responsibilities

### MCP — internal tools

Expose inventory lookup, approved-vendor lookup, and policy retrieval through an MCP server. Implement tool discovery, typed arguments, authentication, and server-side access checks. The purchasing service remains responsible for deciding whether a proposed action is allowed. [MCP architecture](https://modelcontextprotocol.io/docs/learn/architecture)

### A2A — supplier collaboration

Run each supplier as a separate A2A service. Discover its Agent Card, submit a quotation task, receive status updates, and collect a structured quote artifact. The request-for-quotation schema is an application contract; A2A provides the interaction framework. [A2A concepts](https://a2a-protocol.org/latest/topics/key-concepts/)

### UCP — merchant A

Read the merchant profile, negotiate supported capabilities, and use the selected checkout binding. Keep discovery, fulfillment, and payment-handler support explicit. [UCP concepts](https://ucp.dev/documentation/core-concepts/)

### ACP — merchant B

Implement a separate adapter against the released checkout schema. Keep native checkout identifiers, errors, and required fields. ACP here means the OpenAI/Stripe Agentic Commerce Protocol. [ACP repository](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)

AP2 authorization can be added later on a supported checkout path. It is not required to prove the initial four-protocol integration.

---

## 4. MVP scope

### Build first

- one organization and one authenticated buyer
- one product category: monitors
- two independently running supplier agents
- one UCP merchant and one ACP merchant
- one currency: USD
- one order per procurement request
- human approval of the final checkout
- simulated payment-provider responses
- durable workflow state, retries, and reconciliation

### Add after the MVP

- one real provider sandbox or testnet payment path
- AP2 authorization on the UCP merchant
- order-status updates and cancellations

### Defer

- splitting one purchase across merchants
- cross-border tax calculation
- generalized negotiation over legal terms
- real supplier onboarding
- fully autonomous high-value purchasing

Use fixtures for inventory, shipping, and tax rules. Clearly label those fixtures in the demo.

---

## 5. Recommended technology stack

- **Frontend:** Next.js, TypeScript, Tailwind CSS
- **API and workers:** TypeScript with Fastify
- **Storage:** PostgreSQL
- **Background execution:** a durable worker; BullMQ and Redis if needed
- **Protocols:** official SDKs where suitable, generated clients from pinned schemas otherwise
- **Validation:** JSON Schema validation at protocol boundaries
- **Agent:** an LLM with structured tool calls; deterministic fixtures for reproducible tests
- **Observability:** structured events and trace identifiers
- **Local environment:** Docker Compose

Keep the supplier agents as separate processes even when everything runs on one machine. Their separation is part of the interoperability demonstration.

---

## 6. High-level architecture

```text
Buyer → Procurement UI → Buyer agent
                            ├─ MCP client → Company tools
                            ├─ A2A client → Supplier A / Supplier B
                            └─ Procurement workflow
                                  ├─ Policy + quote comparison
                                  ├─ UCP adapter → Merchant A
                                  ├─ ACP adapter → Merchant B
                                  └─ Approval + execution coordinator

PostgreSQL ← workflow events, reservations, native references, receipts
Recovery worker → merchant status queries and unresolved attempts
```

The agent proposes actions. The workflow validates and persists them. Protocol adapters translate requests without silently dropping constraints.

---

## 7. Core components

### A. Intent service

Extract product identity, quantity, budget, delivery deadline, destination, and allowed vendors. Ask for clarification when a hard constraint is missing. Resolve “Friday” to an explicit date in the user's time zone before approval.

### B. Company MCP server

Suggested application tools:

- `get_inventory(product_category)`
- `get_purchasing_policy(cost_center)`
- `list_approved_vendors(product_category)`

Read permissions should not imply purchase permissions.

### C. Supplier agents

Receive the same normalized quotation request. Return item identifiers, quantity available, delivery promise, price components, quote expiry, and merchant endpoint references.

### D. Comparison engine

Reject ineligible offers before ranking eligible ones. Preserve explanations for both accepted and rejected offers.

### E. Checkout coordinator

Build the selected merchant checkout, display final terms, capture approval, and execute exactly one logical completion attempt.

### F. Recovery service

Resolve timeouts by querying the existing checkout or order. An ambiguous completion must not trigger an immediate purchase from another merchant.

---

## 8. End-to-end flow

1. Buyer submits the procurement request.
2. Intent service produces a structured draft.
3. Company tools supply inventory and policy data.
4. Buyer confirms missing requirements.
5. A2A requests go to both suppliers.
6. Supplier agents return quote artifacts.
7. Comparison engine filters and ranks offers.
8. Selected merchant adapter creates a checkout.
9. Workflow revalidates final price, availability, and delivery.
10. Buyer approves the immutable checkout snapshot.
11. Budget is reserved atomically.
12. Coordinator persists an execution attempt before calling the merchant.
13. Merchant accepts, rejects, or leaves the outcome uncertain.
14. Recovery worker resolves uncertainty without creating another order.
15. Receipt combines approval, checkout, order, and payment references.

---

## 9. Application data model

### `procurement_requests`

- `id`, `organization_id`, `buyer_id`, `cost_center_id`
- `product_constraints_json`, `quantity`, `delivery_deadline`
- `currency`, `budget_minor`, `status`, `version`
- `created_at`, `updated_at`

### `supplier_tasks`

- `id`, `procurement_request_id`, `supplier_id`
- `a2a_task_id`, `a2a_context_id`, `native_status`
- `deadline`, `last_event_at`, `artifact_reference`

### `quotes`

- `id`, `supplier_task_id`, `merchant_id`, `native_quote_id`
- `items_json`, `subtotal_minor`, `tax_minor`, `shipping_minor`
- `total_minor`, `currency`, `delivery_date`, `expires_at`
- `eligibility_result`, `ranking_explanation`

### `checkout_attempts`

- `id`, `procurement_request_id`, `protocol`, `protocol_version`
- `native_checkout_id`, `native_order_id`, `native_status`
- `approved_snapshot_digest`, `idempotency_key`
- `completion_state`, `payment_state`, `last_reconciled_at`

### Supporting records

- `approvals`: actor, snapshot digest, time, expiry, authentication context
- `budget_reservations`: amount, request, state, unique execution reference
- `protocol_events`: direction, operation, version, redacted payload, trace ID
- `receipts`: order references, payment evidence, final totals

Store monetary amounts as integer minor units with an explicit currency. Use decimal strings for integers crossing JSON boundaries when needed. Preserve native messages separately from normalized application records.

---

## 10. API design

These are application endpoints. Merchant-facing protocol endpoints must follow their own pinned specifications.

```http
POST /v1/procurement-requests
GET  /v1/procurement-requests/{id}
POST /v1/procurement-requests/{id}/solicit-quotes
GET  /v1/procurement-requests/{id}/quotes
POST /v1/procurement-requests/{id}/select-quote
POST /v1/procurement-requests/{id}/approve
POST /v1/procurement-requests/{id}/execute
GET  /v1/procurement-requests/{id}/timeline
GET  /v1/procurement-requests/{id}/receipt
```

Example creation body:

```json
{
  "cost_center_id": "engineering",
  "product": { "category": "monitor", "minimum_size_inches": 27 },
  "quantity": 10,
  "currency": "USD",
  "budget_minor": "200000",
  "delivery_deadline": "2026-10-02T17:00:00+05:30",
  "destination_id": "office_1",
  "allowed_merchants": ["merchant_a", "merchant_b"]
}
```

Mutation endpoints require caller authorization and an idempotency key. Reusing a key with a different request body returns a conflict.

---

## 11. Adapter design

Use an application interface such as:

```ts
interface CommerceAdapter {
  discover(merchantId: string): Promise<CapabilitySnapshot>;
  createCheckout(input: CheckoutInput): Promise<CheckoutView>;
  getCheckout(nativeId: string): Promise<CheckoutView>;
  complete(input: CompletionInput): Promise<CompletionOutcome>;
  reconcile(attemptId: string): Promise<ReconciliationResult>;
}
```

This is conceptual TypeScript, not a protocol SDK interface.

Each adapter should:

- validate outgoing and incoming native messages
- persist the negotiated version and capability set
- retain native status and error details
- reject unsupported mandatory requirements
- keep payment credentials scoped to their merchant and provider

Do not claim generic UCP-to-ACP translation. Implement two independently tested integrations behind a limited common application model.

---

## 12. Quote comparison rules

First apply hard constraints:

- required product characteristics
- sufficient stock
- permitted merchant
- delivery deadline
- unexpired quote
- delivered total within budget
- supported checkout and payment path

Then rank eligible offers by delivered cost, delivery buffer, and configurable buyer preference. Use deterministic tie-breaking.

Example fixture:

- Merchant A: $1,780, delivery after the deadline → ineligible
- Merchant B: $1,900 including delivery, arrives on time → eligible

Explain this decision using the specific failed constraint. Missing delivery information is unknown, not an implied promise.

---

## 13. Approval and budget enforcement

Approval binds to an immutable snapshot containing merchant, items, quantities, delivered total, currency, destination, and relevant terms.

If those terms change, invalidate the approval and return to review. An agent's statement that the user approved is not approval evidence.

Maintain:

```text
available budget = allocated budget - committed spend - active reservations
```

Reserve using a database transaction and row-level locking. Record the execution attempt and outbox event in the same transaction. After an external request begins, keep the reservation until its financial outcome is resolved.

This is an organizational spending ledger, not a claim that the application holds customer funds.

---

## 14. State machines

Application workflow:

```text
draft → collecting_quotes → comparing → awaiting_approval
awaiting_approval → approved → completing → ordered
completing → reconciliation_required → ordered | rejected
awaiting_approval → expired | cancelled
approved → awaiting_approval  [checkout terms changed]
```

Track payment separately:

```text
not_started → pending → succeeded | failed | outcome_unknown
```

A successful payment with an unresolved order is an exception requiring reconciliation. Cancelling local work does not reverse a merchant order or settled payment.

---

## 15. Recovery and idempotency

### Supplier timeout

Record the missing quote, continue with eligible received offers if policy permits, and expose the incomplete comparison.

### Merchant completion timeout

Query the existing checkout using its native reference. Reuse the original operation identity where the protocol supports retry. Do not switch merchants while completion may have succeeded.

### Worker crash

Recover the persisted attempt. Use an outbox and unique constraints to prevent repeated local state transitions.

### Payment accepted, order rejected

Open an exception case. Use the supported void/refund path when available; do not represent a local database rollback as repayment.

---

## 16. Security boundaries

- Treat supplier text and artifacts as untrusted input.
- Validate schema and business constraints outside the LLM.
- Restrict discovery fetches to approved endpoints and block unintended internal-network access.
- Verify authenticated merchant identity before accepting a new payment destination.
- Keep signing and payment credentials outside prompts and ordinary logs.
- Scope database access to the authenticated organization.
- Protect approval endpoints against unauthorized or cross-session confirmation.

Authenticated messages can still contain malicious or inaccurate content. Provenance and business eligibility need separate checks.

---

## 17. User interface and observability

Build four screens:

1. **Request:** requirements, budget, delivery deadline, cost center.
2. **Comparison:** eligible offers and explicit rejection reasons.
3. **Approval:** exact final terms and any changes since quotation.
4. **Order detail:** lifecycle, receipt, exceptions, and expandable protocol trace.

Measure quote latency, completion outcomes, reconciliation backlog, duplicate attempts prevented, and approval invalidations. Report sample sizes with latency statistics.

Keep protocol details in an inspector so the ordinary buying flow remains readable.

---

## 18. Phased delivery plan

### Phase 1 — deterministic procurement core

Build application models, quote fixtures, ranking, approval, budget reservations, and workflow persistence.

Success: the buyer can choose an eligible offer and recover a simulated timeout.

### Phase 2 — MCP and A2A

Add the company MCP server and two independent A2A suppliers.

Success: a recorded trace proves tool discovery, task exchange, and structured quote collection.

### Phase 3 — UCP and ACP

Add one merchant per protocol, validate native schemas, and complete separate purchases through both adapters.

Success: both routes pass the same application invariants while retaining protocol-specific evidence.

### Phase 4 — realistic execution and recovery

Add one provider sandbox or testnet path, restart tests, failure injection, and reconciliation views.

Success: a lost completion response produces one order and one financial effect.

---

## 19. Suggested build roadmap

Planning estimate: **four focused weeks for one developer**, assuming access to compatible SDKs. Each milestone matters more than the calendar.

- Week 1: schemas, comparison engine, approval snapshot, durable execution stub.
- Week 2: MCP tools, supplier A2A services, task progress, quote artifacts.
- Week 3: UCP/ACP integrations, capability handling, merchant fixtures.
- Week 4: sandbox execution, recovery cases, UI, protocol evidence, documentation.

Keep multi-merchant splitting and autonomous authorization outside this first release.

---

## 20. Testing strategy

### Unit and property tests

- no selected quote violates a hard constraint
- delivered total includes all configured charges
- monetary arithmetic remains exact
- a changed snapshot invalidates approval
- a repeated mutation cannot create another reservation

### Integration tests

- supplier task completes and yields a valid artifact
- unsupported merchant capability blocks execution
- UCP and ACP native examples validate independently
- concurrent approvals cannot overspend the cost center
- restart after merchant submission preserves the attempt identity

### Failure tests

- expired quote
- wrong currency
- injected supplier instruction to bypass policy
- completion response lost after order creation
- duplicate and out-of-order merchant events

---

## 21. Demo scenarios

### Demo A — constraint-aware selection

The cheaper supplier misses the deadline. The more expensive eligible offer wins.

### Demo B — changed checkout

Shipping increases after quotation. The old approval becomes invalid and the buyer sees the revised total.

### Demo C — independent protocol paths

Purchase from merchant A, then run another request through merchant B. Show the native messages and normalized outcome.

### Demo D — uncertain completion

Drop the merchant response after acceptance. Recover the order without buying again.

---

## 22. Repository structure

```text
cross-merchant-procurement/
  apps/
    web/
    api/
    worker/
    company-mcp/
    supplier-a/
    supplier-b/
    merchant-ucp/
    merchant-acp/
  packages/
    procurement-domain/
    commerce-adapters/
    protocol-contracts/
    policy/
    audit/
  fixtures/
  migrations/
  tests/{unit,integration,recovery}/
  docs/
  docker-compose.yml
  README.md
```

---

## 23. Definition of done and portfolio framing

The MVP is complete when both merchants can be purchased from through their actual protocol paths; approvals bind to final terms; and duplicate/recovery tests prove one logical purchase remains one order.

Include an architecture diagram, specification manifest, setup instructions, sample data, test report, recorded protocol trace, and four-minute demo script.

Portfolio wording to use after implementing the described capabilities:

> Built a procurement agent that uses MCP for company tools, A2A for supplier quotation tasks, and separate UCP/ACP checkout adapters, with budget controls, exact purchase approvals, and recovery from ambiguous order outcomes.

---

## 24. Protocol baseline and immediate next steps

Start from released schemas. The ACP repository currently exposes a **2026-04-17** snapshot; UCP has dated releases. Record the selected specification URL, immutable revision, SDK version, and supported capabilities in `docs/protocol-versions.md`. Verify the chosen release supports the operations before building an adapter.

Primary references:

- [MCP architecture](https://modelcontextprotocol.io/docs/learn/architecture)
- [A2A concepts and task model](https://a2a-protocol.org/latest/topics/key-concepts/)
- [UCP specification](https://ucp.dev/specification/overview/)
- [ACP released specifications](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)

Begin with one request, two deterministic quotes, one approval snapshot, and one recoverable completion attempt. Add protocol integrations around that working domain model.

**One-sentence summary:** A buyer agent that coordinates suppliers and completes standards-based purchases while preserving budget, delivery, authorization, and recovery guarantees.
