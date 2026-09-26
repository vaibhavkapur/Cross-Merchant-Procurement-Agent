/**
 * Drive demo scenario A against a running API (or print the curl script).
 */
import { loadCompany, loadScenarios } from "@procurement/domain";

const api = process.env.API_URL ?? "http://127.0.0.1:4000";
const token = loadCompany().principals[0]!.token;
const scenario = loadScenarios().A!;

async function call(method: string, path: string, body?: unknown, idem?: string): Promise<Record<string, any>> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(idem ? { "idempotency-key": idem } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const preview = await call("POST", "/v1/intent/preview", { text: scenario.text, scenario: "A" });
const created = await call("POST", "/v1/procurement-requests", { text: scenario.text, scenario: "A" }, "demo-create");
const id = created.request.id as string;
const quotes = await call("POST", `/v1/procurement-requests/${id}/solicit-quotes`, {}, "demo-quotes");
const eligible = (quotes.quotes as Array<{ id: string; eligibility: { eligible: boolean } }>).find((q) => q.eligibility?.eligible);
if (!eligible) throw new Error("expected an eligible quote in demo A");
await call("POST", `/v1/procurement-requests/${id}/select-quote`, { quote_id: eligible.id }, "demo-select");
await call("POST", `/v1/procurement-requests/${id}/approve`, {}, "demo-approve");
await call("POST", `/v1/procurement-requests/${id}/execute`, {}, "demo-execute");
for (let i = 0; i < 25; i++) {
  const tl = await call("GET", `/v1/procurement-requests/${id}/timeline`);
  if (tl.request.status === "ordered") {
    const receipt = await call("GET", `/v1/procurement-requests/${id}/receipt`);
    process.stdout.write(`${JSON.stringify({ preview: preview.intent, request: tl.request, receipt: receipt.receipt }, null, 2)}\n`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 400));
}
throw new Error("demo A did not reach ordered");
