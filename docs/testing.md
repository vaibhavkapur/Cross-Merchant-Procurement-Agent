# Testing

[Documentation home](index.md)

## Automated checks

```bash
npm ci
npm run typecheck
npm test
```

The aggregate Node test command runs with concurrency one. Focused scripts are `test:unit`, `test:integration`, and `test:recovery`. Unit coverage includes money, comparison, snapshot hashing, policy, ledger rules, intent, and native schemas. Integration/recovery checks cover MCP/A2A flows, UCP and ACP purchases, budget concurrency, changed terms, and dropped completion responses.

## Protocol manifest and demos

```bash
npm run spec:manifest
npm run demo
```

The manifest prints vendored protocol hashes. The demo script drives the local fixture scenario; consult `scripts/demo.ts` and [Demo Script](demo-script.md) for the supported flow. Keep the development stack running when using its HTTP demo client.

`npm run test:report` regenerates the tracked [Test Report](test-report.md). Its existing results are a dated snapshot, not a claim about every later commit. Treat current command output as authoritative.

## Evidence scope

Inspect native checkout/order references, approval invalidation, budget state, and outbox recovery together. Fixture pass results do not establish external merchant interoperability, live settlement, or compliance with unpinned protocol revisions.
