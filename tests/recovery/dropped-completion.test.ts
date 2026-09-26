import assert from "node:assert/strict";
import { test } from "node:test";
import { startStack } from "../helpers.ts";

async function api(stack: Awaited<ReturnType<typeof startStack>>, method: string, path: string, body?: unknown, idem = `r_${method}_${Math.random()}`) {
  const res = await fetch(`${stack.urls.api}${path}`, {
    method,
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json", "idempotency-key": idem },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

test("demo D: dropped completion is recovered as one order", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const created = await api(stack, "POST", "/v1/procurement-requests", { text: "Buy 10 monitors, at least 27 inch, total ≤ $2,000 including delivery, delivered to HQ before Friday, charge IT Hardware", scenario: "D" }, "d-create");
  const id = created.json.request.id as string;
  const quotes = await api(stack, "POST", `/v1/procurement-requests/${id}/solicit-quotes`, {}, "d-quotes");
  const eligible = (quotes.json.quotes as Array<{ id: string; eligibility: { eligible: boolean } }>).find((q) => q.eligibility.eligible)!;
  await api(stack, "POST", `/v1/procurement-requests/${id}/select-quote`, { quote_id: eligible.id }, "d-select");
  await api(stack, "POST", `/v1/procurement-requests/${id}/approve`, {}, "d-approve");
  await api(stack, "POST", `/v1/procurement-requests/${id}/execute`, {}, "d-exec");
  const start = Date.now();
  let timeline: { request: { status: string }; attempts: Array<{ completion_state: string; idempotency_key: string }>; receipt: { order_references: { native_order_id: string } } | null } | null = null;
  while (Date.now() - start < 20_000) {
    const tl = await api(stack, "GET", `/v1/procurement-requests/${id}/timeline`);
    timeline = tl.json;
    if (tl.json.request.status === "ordered") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(timeline?.request.status, "ordered");
  const orders = (await fetch(`${stack.urls.merchantB}/fixture/orders`).then((r) => r.json())) as { orders: Array<{ order_id: string }> };
  assert.equal((orders.orders as unknown[]).length, 1);
  assert.equal(timeline?.receipt?.order_references.native_order_id, (orders.orders as Array<{ order_id: string }>)[0]?.order_id);
});

test("demo B: shipping increase after approval invalidates the snapshot", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const created = await api(stack, "POST", "/v1/procurement-requests", { text: "Buy 10 monitors, at least 27 inch, total ≤ $2,000 including delivery, delivered to HQ before Friday, charge IT Hardware", scenario: "B" }, "b-create");
  const id = created.json.request.id as string;
  const quotes = await api(stack, "POST", `/v1/procurement-requests/${id}/solicit-quotes`, {}, "b-quotes");
  const eligible = (quotes.json.quotes as Array<{ id: string; eligibility: { eligible: boolean } }>).find((q) => q.eligibility.eligible)!;
  await api(stack, "POST", `/v1/procurement-requests/${id}/select-quote`, { quote_id: eligible.id }, "b-select");
  const approved = await api(stack, "POST", `/v1/procurement-requests/${id}/approve`, {}, "b-approve");
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const executed = await api(stack, "POST", `/v1/procurement-requests/${id}/execute`, {}, "b-exec");
  assert.equal(executed.status, 409, JSON.stringify(executed.json));
  assert.equal(executed.json.error, "terms_changed");
  const tl = await api(stack, "GET", `/v1/procurement-requests/${id}/timeline`);
  assert.equal(tl.json.request.status, "awaiting_approval");
  assert.ok((tl.json.approvals as Array<{ state: string }>).some((a) => a.state === "invalidated"));
});
