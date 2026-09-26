# Deployment

[Documentation home](index.md)

## Local stack

```bash
npm ci
npm run dev
```

The runner supervises company MCP, suppliers, merchants, API, worker, and optional web processes. Stop it with Ctrl-C. For individual processes use the `dev:*` scripts in `package.json`; all persistent buyer processes must share database configuration.

## Compose

The Compose services mount the source directory and execute Node directly; they do not build or install dependencies themselves. Install with Node.js 22.18+ first:

```bash
npm ci
docker compose up
docker compose ps
```

On a host whose dependencies are incompatible with the Linux containers, install inside a compatible Linux checkout before running this topology. The Compose file is a development environment, not a packaged production image.

API is on `4000`, UI on `3000`, company MCP on `4010`, suppliers on `4021`/`4022`, and merchants on `4031`/`4032`. PostgreSQL binds `5432`. Use `curl http://127.0.0.1:4000/healthz` and `docker compose logs api worker` to inspect readiness and processing.

## Operational scope

Monitor reconciliation backlog and inspect native receipts before treating an execution as complete. Keep merchant fixtures alive for worker-restart recovery demonstrations. The database service has no explicitly configured named data volume in this Compose file.

Bearer credentials, company policy, supplier catalogs, payment references, and merchant orders are fixtures. The existing permissive CORS and synthetic identities are part of that local setup. See [Configuration](configuration.md), [Database](database.md), and [Protocol Versions](protocol-versions.md) for the implemented boundaries.
