# Configuration

[Documentation home](index.md)

## Runtime and data

Environment variables are read directly from `process.env`. Export them before starting a process; no root `.env` loader is configured.

- `DATABASE_URL`: selects PostgreSQL when set to a PostgreSQL URL; otherwise the default SQLite store is used. API and worker must use the same database.
- `HOST`: `0.0.0.0`; API `PORT`: `4000`.
- `PUBLIC_URL`: defaults to `http://127.0.0.1:4000` for the API.
- `COMPANY_MCP_URL`: `http://127.0.0.1:4010/mcp`.
- `PLATFORM_UCP_PROFILE_URL`: defaults to `<PUBLIC_URL>/.well-known/ucp`.
- `PAYMENT_CREDENTIAL_REF`: defaults to the company fixture's credential reference; it is not a raw payment key.
- `WORKER_POLL_MS`: `400` milliseconds.
- `FIXTURES_DIR`: repository `fixtures/` by default.

## Merchant and supplier addresses

Fixture IDs determine override names:

- `MERCHANT_MERCHANT_A_URL`: UCP merchant address.
- `MERCHANT_MERCHANT_B_URL`: ACP merchant address.
- `SUPPLIER_SUPPLIER_A_URL` and `SUPPLIER_SUPPLIER_B_URL`: supplier agent addresses.

Defaults come from `fixtures/merchants.json` and `fixtures/suppliers.json`. Merchant API-key environment names and development fallbacks are declared in the merchant fixture file. Company bearer tokens and roles come from `fixtures/company.json`.

## Web and development runner

The browser uses `NEXT_PUBLIC_API_URL`. `scripts/dev.ts` starts fixed local ports and supplies the web URL as `http://127.0.0.1:4000`; use individual `dev:*` scripts for custom process layouts. Compose supplies internal service names for backend traffic and the host-visible address for the browser.

Protocol versions are pinned in [Protocol Versions](protocol-versions.md) and vendored contracts. Changing a service URL does not change supported protocol versions or turn fixture payment credentials into a live integration.
