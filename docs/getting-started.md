# Getting Started

[Documentation home](index.md)

## Prerequisites

Node.js **22.18+**, npm, and Git are required. The scripts run TypeScript directly with Node and use its SQLite support. Docker Compose is optional.

## Clone, install, and start

```bash
git clone https://github.com/vaibhavkapur/Cross-Merchant-Procurement-Agent.git
cd Cross-Merchant-Procurement-Agent
npm ci
npm run typecheck
npm test
npm run dev
```

The development runner starts the API (`4000`), worker, company MCP server (`4010`), two supplier agents (`4021`, `4022`), UCP merchant (`4031`), ACP merchant (`4032`), and Next.js UI (`3000`). Wait for the processes to listen.

Open [the UI](http://127.0.0.1:3000), or check `curl http://127.0.0.1:4000/healthz`. The fixture bearer token is `fixture-token-alice`. SQLite at `data/procurement.db` is the default; no database container is required.

## First procurement

Choose Demo A: ten monitors, at least 27 inches, delivered to HQ before Friday, total at most $2,000, charged to IT Hardware. Solicit quotes, inspect eligibility, select the eligible quote, review the final checkout, approve, and execute.

In the fixture, merchant A's lower price misses the short delivery deadline; merchant B's ACP checkout is eligible. Demo C extends the deadline so the UCP route can win. These are fixture outcomes, not live vendor offers.

The [API Reference](api-reference.md) gives the same sequence and required idempotency headers. [Demo Script](demo-script.md) includes changed terms and uncertain completion. To run the server stack without the UI, use `npm run dev -- --no-web`.

## Next steps

Read [Architecture](architecture.md), [Configuration](configuration.md), [Database](database.md), and [Testing](testing.md). PostgreSQL and container operation are described in [Deployment](deployment.md). Protocol version differences are intentional; see [Protocol Versions](protocol-versions.md).
