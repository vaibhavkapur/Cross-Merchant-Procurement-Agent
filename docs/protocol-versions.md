# Protocol versions

This build pins released schemas. Do not treat adapters as a generic UCP-to-ACP translator.

| Protocol | Role | Version | Specification | Immutable revision | SDK / vendor |
| --- | --- | --- | --- | --- | --- |
| MCP | Company tools | 2025-06-18 (SDK-negotiated) | https://modelcontextprotocol.io/docs/learn/architecture | npm `@modelcontextprotocol/sdk@1.30.x` | Streamable HTTP |
| A2A | Supplier quotation tasks | 1.0 | https://a2a-protocol.org/latest/topics/key-concepts/ | npm `@a2a-js/sdk@1.2.1` | JSON-RPC + Agent Card |
| UCP | Merchant A checkout | **2026-08-25** | https://ucp.dev/specification/overview/ | git tag `v2026-08-25` | vendored under `packages/protocol-contracts/vendor/ucp/v2026-08-25` |
| ACP | Merchant B checkout | **2026-01-16** | https://github.com/agentic-commerce-protocol/agentic-commerce-protocol | dated directory `spec/2026-01-16` | vendored under `packages/protocol-contracts/vendor/acp/2026-01-16` |

## Why ACP 2026-01-16 instead of 2026-04-17

The 2026-04-17 snapshot was evaluated and not selected. Its `CheckoutSessionCreateRequest` item object has no `quantity` member (`additionalProperties: false`), so a 10-unit purchase cannot be expressed as a schema-valid create request. 2026-01-16 supports `items[].quantity`.

## Operations each adapter relies on

**UCP (REST shopping service)**

- `GET /.well-known/ucp` — business profile and capability negotiation
- `POST /checkout-sessions` — create
- `GET /checkout-sessions/{id}` — read / reconcile
- `PUT /checkout-sessions/{id}` — full-replacement update (select fulfillment)
- `POST /checkout-sessions/{id}/complete`
- `POST /checkout-sessions/{id}/cancel`

**ACP (Agentic Checkout)**

- `POST /checkout_sessions`
- `GET /checkout_sessions/{id}`
- `POST /checkout_sessions/{id}` — update
- `POST /checkout_sessions/{id}/complete`
- `POST /checkout_sessions/{id}/cancel`

ACP 2026-01-16 defines no discovery document. The fixture merchant publishes `/.well-known/acp-fixture-capabilities` so capability checks stay explicit.

Print the hashed manifest with `npm run spec:manifest`.
