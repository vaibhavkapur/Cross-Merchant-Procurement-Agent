# Architecture

```text
Buyer → Procurement UI → Buyer API
                            ├─ MCP client → Company tools (inventory, policy, vendors)
                            ├─ A2A client → Supplier A / Supplier B
                            └─ Procurement workflow
                                  ├─ Policy + quote comparison
                                  ├─ UCP adapter → Merchant A
                                  ├─ ACP adapter → Merchant B
                                  └─ Approval + execution coordinator

PostgreSQL or SQLite ← workflow events, reservations, native references, receipts
Recovery worker → merchant status queries and unresolved attempts
```

The agent proposes actions. The workflow validates and persists them. Protocol adapters translate requests without silently dropping constraints.

## Processes

| Process | Default URL | Protocol |
| --- | --- | --- |
| `apps/web` | http://127.0.0.1:3000 | HTTPS UI |
| `apps/api` | http://127.0.0.1:4000 | Application REST |
| `apps/worker` | (no listen) | Outbox consumer |
| `apps/company-mcp` | http://127.0.0.1:4010/mcp | MCP Streamable HTTP |
| `apps/supplier-a` | http://127.0.0.1:4021 | A2A JSON-RPC |
| `apps/supplier-b` | http://127.0.0.1:4022 | A2A JSON-RPC |
| `apps/merchant-ucp` | http://127.0.0.1:4031 | UCP REST |
| `apps/merchant-acp` | http://127.0.0.1:4032 | ACP REST |

Suppliers stay separate processes even on one machine. That separation is part of the interoperability demonstration.

## Recovery

1. `execute` writes a budget reservation and an `execute_checkout` outbox row in one transaction.
2. The worker calls the merchant `complete` with the attempt's idempotency key.
3. If the response is lost after the merchant accepted, completion state is `outcome_unknown`.
4. A `reconcile_attempt` message queries the native checkout. A second purchase is never created.

## Demo fixtures

Prices, tax (0 bps), and shipping rules live in `fixtures/`. Every simulated failure is an explicit flag on the procurement request (`supplier_timeout`, `shipping_increase`, `drop_completion_response`, `inject_policy_bypass`).
