"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, money } from "../lib/api";

export default function RequestPage() {
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof api.meta>> | null>(null);
  const [requests, setRequests] = useState<Awaited<ReturnType<typeof api.list>>["requests"]>([]);
  const [text, setText] = useState("");
  const [scenario, setScenario] = useState("A");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.meta().then(setMeta).catch((e) => setError(String(e)));
    api.list().then((r) => setRequests(r.requests)).catch(() => undefined);
  }, []);

  const applyScenario = (id: string) => {
    setScenario(id);
    const s = meta?.scenarios[id];
    if (s) setText(s.text);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.create({ text, scenario }, `ui-create-${Date.now()}`);
      window.location.href = `/requests/${created.request.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-8 md:grid-cols-[2fr,1fr]">
      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium">1. Request</h2>
        <p className="text-sm text-slate-400">Inventory, policy, and shipping rules below are labelled fixtures.</p>
        <div className="flex flex-wrap gap-2">
          {meta &&
            Object.entries(meta.scenarios).map(([id, s]) => (
              <button key={id} type="button" onClick={() => applyScenario(id)} className={`rounded-full px-3 py-1 text-sm ${scenario === id ? "bg-sky-500 text-slate-950" : "bg-slate-800 text-slate-200"}`}>
                Demo {id}: {s.title}
              </button>
            ))}
        </div>
        <textarea className="h-36 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder="Buy 10 monitors…" />
        {meta?.scenarios[scenario] && <p className="text-xs text-slate-400">{meta.scenarios[scenario].expect}</p>}
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button type="button" disabled={busy || !text} onClick={submit} className="rounded-lg bg-sky-500 px-4 py-2 font-medium text-slate-950 disabled:opacity-50">
          {busy ? "Creating…" : "Create procurement request"}
        </button>
      </section>
      <aside className="space-y-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm">
          <h3 className="mb-2 font-medium">Fixture company</h3>
          <p>{meta?.organization.name ?? "…"}</p>
          <ul className="mt-2 space-y-1 text-slate-400">
            {meta?.cost_centers.map((c) => (
              <li key={c.id}>{c.name}</li>
            ))}
            {meta?.destinations.map((d) => (
              <li key={d.destination_id}>{d.name}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm">
          <h3 className="mb-2 font-medium">Recent requests</h3>
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id}>
                <Link href={`/requests/${r.id}`} className="block">
                  <span className="font-mono text-xs text-slate-500">{r.status}</span>
                  <span className="ml-2">
                    {r.quantity} {r.product_constraints.category} · {money(r.budget_minor, r.currency)}
                  </span>
                </Link>
              </li>
            ))}
            {requests.length === 0 && <li className="text-slate-500">None yet</li>}
          </ul>
        </div>
      </aside>
    </div>
  );
}
