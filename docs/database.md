# Database and Recovery

[Documentation home](index.md)

## Storage and schema

`packages/procurement-domain/src/db/` implements SQLite and PostgreSQL drivers. SQLite is stored at `data/procurement.db` by default. PostgreSQL is selected with `DATABASE_URL`. Startup creates the store and applies the existing migration path; there is no separate `npm run migrate` script.

Records include procurement requests, supplier tasks, quotes, checkout snapshots, approvals, execution attempts, budget reservations, outbox work, protocol events, idempotency responses, and receipts. API and worker must share the same database and fixture configuration.

## Budget and approval integrity

Budget reservation and the execution outbox entry are written transactionally. SQLite serializes writers with `BEGIN IMMEDIATE`; PostgreSQL uses row locking in the ledger path. Approval is tied to a checkout snapshot digest, and changed terms invalidate it before execution proceeds.

## Uncertain completion

The worker completes the selected merchant's native checkout using the attempt's idempotency key. A lost response leaves an uncertain attempt for reconciliation. Reading the merchant checkout establishes whether an order already exists before another external action is attempted.

The buyer database is durable, but fixture merchants keep their own state in process memory. A worker restart while merchants remain alive exercises recovery; recreating all merchants can remove the independent order evidence. The supplied Compose PostgreSQL service has no explicit named data volume, so review persistence before relying on container replacement to retain buyer state.

Use [Architecture](architecture.md) and [Demo Script](demo-script.md) to follow the outbox and protocol trace. Prices, delivery times, tax, and payment results are synthetic fixtures.
