# API Reference

[Documentation home](index.md)

## Base URL and credentials

The local API is `http://127.0.0.1:4000`. All application routes require `Authorization: Bearer fixture-token-alice` (or another principal from `fixtures/company.json`). `/healthz` and discovery under `/.well-known/` are exempt. Routes are defined in `apps/api/src/app.ts`; there is no generated Swagger UI in this service.

## Idempotency

Every state-changing procurement-request route uses `Idempotency-Key`. Reuse the same key and body when retrying an operation. A missing key returns 400; reusing it with a different body returns 409. A replay returns the cached response with `Idempotent-Replayed: true`. The scope includes principal, method, and URL.

`POST /v1/intent/preview` only previews interpretation and does not require an idempotency key.

## Procurement flow

1. `POST /v1/intent/preview` with `text` and optional `scenario`: inspect extracted constraints.
2. `POST /v1/procurement-requests` with that request: creates the durable request. The response contains `request.id`. Structured fields can specify product, quantity, currency, `budget_minor`, deadline, destination, cost center, and allowed merchants.
3. `POST /v1/procurement-requests/{id}/solicit-quotes`: invokes company tools and supplier agents; returns quote eligibility.
4. `GET /v1/procurement-requests/{id}/quotes`: inspect offers and failed constraints.
5. `POST /v1/procurement-requests/{id}/select-quote` with `quote_id`: creates/reads the native checkout and prepares the approval snapshot.
6. Review that snapshot, then `POST /v1/procurement-requests/{id}/approve`.
7. `POST /v1/procurement-requests/{id}/execute`: reserves budget and schedules completion through the worker.

Example selection (replace both IDs with returned values):

```bash
curl -X POST http://127.0.0.1:4000/v1/procurement-requests/REQUEST_ID/select-quote \
  -H "Authorization: Bearer fixture-token-alice" \
  -H "Idempotency-Key: select-001" \
  -H "Content-Type: application/json" \
  -d '{"quote_id":"QUOTE_ID"}'
```

The [README example](../README.md#quick-example) includes creation, selection, approval, and execution. Use a fresh key for a new logical action; an identical retry uses the original key.

## Read, cancel, and inspect

- `GET /v1/meta`: fixture organization, buyer permissions, destinations, cost centers, suppliers, and scenarios.
- `GET /v1/procurement-requests` and `GET /v1/procurement-requests/{id}`: requests within the principal's permitted scope.
- `GET /v1/procurement-requests/{id}/timeline`: workflow and protocol evidence.
- `GET /v1/procurement-requests/{id}/receipt`: native order and checkout receipt.
- `POST /v1/procurement-requests/{id}/cancel`: optional `reason`; requires an idempotency key.
- `GET /v1/metrics`: quote latency samples, attempt states, approvals, and outbox backlog.

## Terms and recovery

Approval is bound to the checkout snapshot. If terms change, approval is invalidated and new review is required. If completion is uncertain, the worker reads the native checkout to establish whether an order exists. Do not treat an accepted execute request as a settled order; inspect request/attempt state and the receipt.

Application errors use `error`, `message`, and optional `details`. Authentication fails with 401; policy/domain errors carry their own status. UCP and ACP payloads remain distinct behind their adapters; this API is an application workflow, not a generic protocol translator.
