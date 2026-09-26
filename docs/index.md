# Cross-Merchant Procurement Agent

A buyer workflow that collects supplier quotes, enforces company constraints, approves a final checkout snapshot, and completes a purchase through separate UCP and ACP adapters.

[Get Started](getting-started.md) · [API Reference](api-reference.md) · [Repository README](../README.md)

## Key Features

- MCP company tools and A2A supplier quotation with explicit eligibility reasons.
- Delivered cost, deadline, budget reservation, and digest-bound approval checks.
- Native protocol traces, durable buyer outbox state, and reconciliation after a lost completion response.

## Tech Stack and Scope

Node.js 22.18+ / TypeScript / Fastify / Next.js; SQLite or PostgreSQL; native Node tests. Company identities, suppliers, merchants, and payment credentials are fixtures.

## Documentation

- [Getting Started](getting-started.md)
- [Architecture](architecture.md)
- [API Reference](api-reference.md)
- [Configuration](configuration.md)
- [Database and Recovery](database.md)
- [Testing](testing.md)
- [Deployment](deployment.md)
- [Protocol Versions](protocol-versions.md)
- [Demo Script](demo-script.md)
- [Recorded Test Report](test-report.md)

## Project Structure

- `apps/`: API, worker, company MCP, suppliers, merchants, and web UI.
- `packages/`: procurement domain, policy, commerce adapters, protocol contracts, and audit.
- `fixtures/`, `migrations/`, `scripts/`, `tests/`: synthetic company data, schema, demos, and checks.

The implementation guides describe the current code. [Development plan](../plan.md) records design intent and future work; planned features are not automatically implemented.

## Related projects

These are independent companion repositories, not runtime dependencies or claims of an implemented integration:

- [Cross-Border Payments Engine](https://github.com/vaibhavkapur/Cross-Border-Payments-Engine): remittance quoting, settlement lifecycle, and ledger demonstration.
- [Stablecoin Payments API](https://github.com/vaibhavkapur/Stablecoin-Payments-API): customer, wallet, deposit, transfer, and checkout API.
- [Agentic Commerce + Stablecoin Checkout](https://github.com/vaibhavkapur/Agentic-Commerce-Stablecoin-Checkout): conversational commerce, policy checks, and payment routing.
- [Smart Wallet Policy Engine](https://github.com/vaibhavkapur/smart-wallet-policy-engine): transaction risk evaluation and wallet authorization.
- [Stablecoin Payment Orchestrator](https://github.com/vaibhavkapur/Stablecoin-Payment-Orchestrator): USDC routing, workers, and treasury accounting.
