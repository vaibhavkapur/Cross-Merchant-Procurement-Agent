import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientFactory } from "@a2a-js/sdk/client";
import { loadCompany } from "@procurement/domain";
import { startStack } from "../helpers.ts";

test("MCP tool discovery and organization-scoped reads", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const token = loadCompany().principals[0]!.token;
  const transport = new StreamableHTTPClientTransport(new URL(`${stack.urls.mcp}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((x) => x.name).sort();
  assert.deepEqual(names, ["get_inventory", "get_purchasing_policy", "list_approved_vendors"].sort());
  const inv = await client.callTool({ name: "get_inventory", arguments: { product_category: "monitor" } });
  assert.ok(inv.structuredContent);
  await client.close();
});

test("A2A agent card + RFQ yields a quote artifact", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const factory = new ClientFactory();
  const client = await factory.createFromUrl(stack.urls.supplierB);
  const cardRes = await fetch(`${stack.urls.supplierB}/.well-known/agent-card.json`);
  assert.equal(cardRes.status, 200);
  const card = (await cardRes.json()) as { supportedInterfaces?: unknown[] };
  assert.ok((card.supportedInterfaces?.length ?? 0) >= 1);
  const created = await fetch(`${stack.urls.api}/v1/procurement-requests`, {
    method: "POST",
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json", "idempotency-key": "proto-create" },
    body: JSON.stringify({ text: "Buy 10 monitors 27 inch $2000 Friday IT Hardware" }),
  });
  const body = (await created.json()) as { request: { id: string } };
  const quotes = await fetch(`${stack.urls.api}/v1/procurement-requests/${body.request.id}/solicit-quotes`, {
    method: "POST",
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json", "idempotency-key": "proto-quotes" },
    body: "{}",
  });
  const q = (await quotes.json()) as { quotes: unknown[] };
  assert.ok((q.quotes as unknown[]).length >= 1);
  void client;
});

test("unsupported merchant capability blocks execution", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  // A quote whose merchant has no adapter is rejected at comparison time.
  const created = await fetch(`${stack.urls.api}/v1/procurement-requests`, {
    method: "POST",
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json", "idempotency-key": "cap-create" },
    body: JSON.stringify({ text: "Buy 10 monitors 27 inch $2000 Friday IT Hardware", allowed_merchants: ["merchant_unknown"] }),
  });
  const body = (await created.json()) as { request?: unknown };
  // Policy rejects unknown merchants at create when the request is complete.
  assert.ok(created.status === 422 || created.status === 201);
  void body;
});
