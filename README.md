# Cross-Merchant Procurement Agent

A buyer agent that coordinates suppliers and completes standards-based purchases while preserving budget, delivery, authorization, and recovery guarantees. Uses MCP for company tools, A2A for supplier quotation, and separate UCP/ACP checkout adapters.

> **[Read the full documentation](docs/index.md)**

Built with Node.js 22.18+, TypeScript, Fastify, and Next.js. Suppliers, merchants, and payment credentials are fixtures.

## Getting Started

```bash
# Requires Node.js 22.18+
npm install
npm test
npm run dev
```

- UI: http://127.0.0.1:3000
- API: http://127.0.0.1:4000
- Bearer token: `fixture-token-alice`

SQLite is the default store (`data/procurement.db`). Set `DATABASE_URL=postgres://…` to use PostgreSQL.

See [Getting Started](docs/getting-started.md) for prerequisites, cloning, configuration, and verification.

## Quick Example

```bash
# Preview constraints from a natural-language request
curl -X POST http://127.0.0.1:4000/v1/intent/preview \
  -H "Authorization: Bearer fixture-token-alice" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Buy 10 monitors, at least 27 inch, total ≤ $2,000 including delivery, delivered to HQ before Friday, charge IT Hardware",
    "scenario": "A"
  }'

# Create the request, solicit quotes, select, approve, and execute
curl -X POST http://127.0.0.1:4000/v1/procurement-requests \
  -H "Authorization: Bearer fixture-token-alice" \
  -H "Idempotency-Key: procurement-001" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Buy 10 monitors, at least 27 inch, total ≤ $2,000 including delivery, delivered to HQ before Friday, charge IT Hardware",
    "scenario": "A"
  }'

curl -X POST http://127.0.0.1:4000/v1/procurement-requests/{id}/solicit-quotes \
  -H "Authorization: Bearer fixture-token-alice" \
  -H "Idempotency-Key: quotes-001"

curl -X POST http://127.0.0.1:4000/v1/procurement-requests/{id}/select-quote \
  -H "Idempotency-Key: select-001" \
  -H "Authorization: Bearer fixture-token-alice" \
  -H "Content-Type: application/json" \
  -d '{ "quote_id": "quo_..." }'

curl -X POST http://127.0.0.1:4000/v1/procurement-requests/{id}/approve \
  -H "Idempotency-Key: approve-001" \
  -H "Authorization: Bearer fixture-token-alice"

curl -X POST http://127.0.0.1:4000/v1/procurement-requests/{id}/execute \
  -H "Idempotency-Key: execute-001" \
  -H "Authorization: Bearer fixture-token-alice"
```

Replace `{id}` with `request.id` from creation and `quo_...` with an eligible quote ID. Review the selected checkout before approval. Keep the worker running and inspect `/v1/procurement-requests/{id}/receipt` after execution.
