import assert from "node:assert/strict";
import { test } from "node:test";
import { startStack } from "../helpers.ts";

async function api(stack: Awaited<ReturnType<typeof startStack>>, method: string, path: string, body?: unknown, idem = `idem_${method}_${path}`) {
  const res = await fetch(`${stack.urls.api}${path}`, {
    method,
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json", "idempotency-key": idem },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as any;
  return { status: res.status, json };
}

async function waitFor(stack: Awaited<ReturnType<typeof startStack>>, id: string, status: string, ms = 15_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const tl = await api(stack, "GET", `/v1/procurement-requests/${id}/timeline`);
    if (tl.json.request?.status === status) return tl.json;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${status}`);
}

test("demo A: deadline beats price and ACP checkout completes", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const created = await api(stack, "POST", "/v1/procurement-requests", { text: "Buy 10 monitors, at least 27 inch, total ≤ $2,000 including delivery, delivered to HQ before Friday, charge IT Hardware", scenario: "A" }, "a-create");
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.request.id as string;
  const quotes = await api(stack, "POST", `/v1/procurement-requests/${id}/solicit-quotes`, {}, "a-quotes");
  assert.equal(quotes.status, 200, JSON.stringify(quotes.json));
  const list = quotes.json.quotes as Array<{ id: string; merchant_id: string; eligibility: { eligible: boolean; failed: string[] }; ranking: { rank: number | null } }>;
  const a = list.find((q) => q.merchant_id === "merchant_a")!;
  const b = list.find((q) => q.merchant_id === "merchant_b")!;
  assert.equal(a.eligibility.eligible, false);
  assert.ok(a.eligibility.failed.includes("delivery_deadline"));
  assert.equal(b.eligibility.eligible, true);
  assert.equal(b.ranking.rank, 1);
  const selected = await api(stack, "POST", `/v1/procurement-requests/${id}/select-quote`, { quote_id: b.id }, "a-select");
  assert.equal(selected.status, 200, JSON.stringify(selected.json));
  const approved = await api(stack, "POST", `/v1/procurement-requests/${id}/approve`, {}, "a-approve");
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const executed = await api(stack, "POST", `/v1/procurement-requests/${id}/execute`, {}, "a-exec");
  assert.equal(executed.status, 200, JSON.stringify(executed.json));
  const tl = await waitFor(stack, id, "ordered");
  assert.equal(tl.receipt.order_references.protocol, "acp");
  const orders = (await fetch(`${stack.urls.merchantB}/fixture/orders`).then((r) => r.json())) as { orders: unknown[] };
  assert.equal((orders.orders as unknown[]).length, 1);
});

test("demo C: later deadline selects the cheaper UCP merchant", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const created = await api(stack, "POST", "/v1/procurement-requests", { text: "Buy 10 monitors, at least 27 inch, total ≤ $2,000 including delivery, delivered to HQ within 3 weeks, charge IT Hardware", scenario: "C" }, "c-create");
  const id = created.json.request.id as string;
  const quotes = await api(stack, "POST", `/v1/procurement-requests/${id}/solicit-quotes`, {}, "c-quotes");
  const list = quotes.json.quotes as Array<{ id: string; merchant_id: string; eligibility: { eligible: boolean }; ranking: { rank: number | null } }>;
  const winner = list.find((q) => q.ranking.rank === 1)!;
  assert.equal(winner.merchant_id, "merchant_a");
  await api(stack, "POST", `/v1/procurement-requests/${id}/select-quote`, { quote_id: winner.id }, "c-select");
  await api(stack, "POST", `/v1/procurement-requests/${id}/approve`, {}, "c-approve");
  await api(stack, "POST", `/v1/procurement-requests/${id}/execute`, {}, "c-exec");
  const tl = await waitFor(stack, id, "ordered");
  assert.equal(tl.receipt.order_references.protocol, "ucp");
});

test("idempotent execute does not create a second reservation", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const created = await api(stack, "POST", "/v1/procurement-requests", { text: "Buy 10 monitors, at least 27 inch, total ≤ $2,000 including delivery, delivered to HQ before Friday, charge IT Hardware" }, "i-create");
  const id = created.json.request.id as string;
  const quotes = await api(stack, "POST", `/v1/procurement-requests/${id}/solicit-quotes`, {}, "i-quotes");
  const eligible = (quotes.json.quotes as Array<{ id: string; eligibility: { eligible: boolean } }>).find((q) => q.eligibility.eligible)!;
  await api(stack, "POST", `/v1/procurement-requests/${id}/select-quote`, { quote_id: eligible.id }, "i-select");
  await api(stack, "POST", `/v1/procurement-requests/${id}/approve`, {}, "i-approve");
  const first = await api(stack, "POST", `/v1/procurement-requests/${id}/execute`, {}, "i-exec");
  const second = await api(stack, "POST", `/v1/procurement-requests/${id}/execute`, {}, "i-exec");
  assert.equal(second.status, 200);
  assert.equal(first.json.reservation.id, second.json.reservation.id);
});

test("reusing an idempotency key with a different body conflicts", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const a = await api(stack, "POST", "/v1/procurement-requests", { text: "Buy 10 monitors 27 inch $2000 Friday IT Hardware" }, "same-key");
  assert.equal(a.status, 201);
  const b = await api(stack, "POST", "/v1/procurement-requests", { text: "Buy 1 keyboard $20 Friday office" }, "same-key");
  assert.equal(b.status, 409);
});
