# Cross-Merchant Procurement Agent

A buyer agent that coordinates suppliers and completes standards-based purchases while preserving budget, delivery, authorization, and recovery guarantees. Uses MCP for company tools, A2A for supplier quotation, and separate UCP/ACP checkout adapters.

> **[Read the full documentation](docs/architecture.md)**

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
  -H "Idempotency-Key: remit-001" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Buy 10 monitors, at least 27 inch, total ≤ $2,000 including delivery, delivered to HQ before Friday, charge IT Hardware",
    "scenario": "A"
  }'

curl -X POST http://127.0.0.1:4000/v1/procurement-requests/{id}/solicit-quotes \
  -H "Authorization: Bearer fixture-token-alice" \
  -H "Idempotency-Key: quotes-001"

curl -X POST http://127.0.0.1:4000/v1/procurement-requests/{id}/select-quote \
  -H "Authorization: Bearer fixture-token-alice" \
  -H "Content-Type: application/json" \
  -d '{ "quote_id": "quo_..." }'

curl -X POST http://127.0.0.1:4000/v1/procurement-requests/{id}/approve \
  -H "Authorization: Bearer fixture-token-alice"

curl -X POST http://127.0.0.1:4000/v1/procurement-requests/{id}/execute \
  -H "Authorization: Bearer fixture-token-alice"
```
