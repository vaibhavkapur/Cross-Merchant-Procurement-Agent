# Test report

Generated: 2026-09-26

| Suite | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | pass | |
| `npm run test:unit` | 24/24 pass | money, comparison, snapshot, ledger, intent, policy, native schemas |
| `npm run test:integration` | 8/8 pass | MCP discovery, A2A quotes, Demo A (ACP), Demo C (UCP), idempotent execute, concurrent budget |
| `npm run test:recovery` | 2/2 pass | Demo D dropped completion → one order; Demo B shipping increase invalidates approval |

Sample sizes are the test counts above. End-to-end quote collection in the integration stack is typically tens of milliseconds after the servers listen; worker completion is sub-second unless a response is dropped (Demo D reconciles on the next probe).
