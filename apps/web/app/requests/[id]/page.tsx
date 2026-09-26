"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, money, when, type Timeline } from "../../../lib/api";

export default function RequestDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [tl, setTl] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openEvent, setOpenEvent] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const next = await api.timeline(id);
    setTl(next);
    return next;
  }, [id]);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  useEffect(() => {
    if (!tl) return;
    if (["completing", "reconciliation_required", "collecting_quotes"].includes(tl.request.status)) {
      const t = setInterval(() => refresh().catch(() => undefined), 800);
      return () => clearInterval(t);
    }
  }, [tl, refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      const err = e as Error & { body?: { message?: string; details?: unknown } };
      setError(err.body?.message ?? err.message);
    } finally {
      setBusy(null);
    }
  };

  if (!tl) return <p className="text-slate-400">{error ?? "Loading…"}</p>;
  const { request, quotes, attempts, approvals, receipt } = tl;
  const attempt = attempts.at(-1);
  const eligible = quotes.filter((q) => q.eligibility?.eligible);
  const rejected = quotes.filter((q) => q.eligibility && !q.eligibility.eligible);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm">
          ← New request
        </Link>
        <span className="font-mono text-xs uppercase tracking-wide text-sky-400">{request.status}</span>
      </div>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium">Constraints</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div>
            <dt className="text-slate-500">Product</dt>
            <dd>
              {request.quantity} × {request.product_constraints.category}
              {request.product_constraints.minimum_size_inches ? ` ≥ ${request.product_constraints.minimum_size_inches}"` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Budget</dt>
            <dd>{money(request.budget_minor, request.currency)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Deadline</dt>
            <dd>{when(request.delivery_deadline)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Cost centre</dt>
            <dd>{request.cost_center_id}</dd>
          </div>
        </dl>
        {request.source_text && <p className="mt-3 text-sm text-slate-400">“{request.source_text}”</p>}
        {Object.keys(request.simulation).length > 0 && <p className="mt-2 font-mono text-xs text-amber-300">Fixture simulation: {JSON.stringify(request.simulation)}</p>}
        {request.status === "draft" && (
          <button className="mt-4 rounded-lg bg-sky-500 px-4 py-2 text-slate-950" disabled={!!busy} onClick={() => run("quotes", () => api.solicit(id, `ui-quotes-${id}`))}>
            {busy === "quotes" ? "Requesting quotes…" : "Solicit quotes from both suppliers"}
          </button>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium">2. Comparison</h2>
        {quotes.length === 0 && <p className="mt-2 text-sm text-slate-500">No quotes yet.</p>}
        <div className="mt-4 space-y-3">
          {eligible.map((q) => (
            <article key={q.id} className="flex items-center justify-between rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-4">
              <div>
                <p className="font-medium">
                  Rank {q.ranking?.rank} · {q.merchant_id} via {q.supplier_id}
                </p>
                <p className="text-sm text-slate-400">
                  {money(q.total_minor, q.currency)} delivered · arrives {when(q.delivery_date)}
                </p>
                <p className="text-xs text-slate-500">{q.ranking?.summary}</p>
              </div>
              {["comparing", "awaiting_approval"].includes(request.status) && (
                <button className="rounded-lg bg-emerald-400 px-3 py-1 text-sm text-slate-950" disabled={!!busy} onClick={() => run("select", () => api.select(id, q.id, `ui-select-${q.id}`))}>
                  Select
                </button>
              )}
            </article>
          ))}
          {rejected.map((q) => (
            <article key={q.id} className="rounded-lg border border-rose-900/50 bg-rose-950/20 p-4">
              <p className="font-medium text-rose-200">
                Ineligible · {q.merchant_id} · {money(q.total_minor, q.currency)}
              </p>
              <ul className="mt-1 list-disc pl-5 text-sm text-rose-100/80">
                {q.eligibility?.checks
                  .filter((c) => !c.passed)
                  .map((c) => (
                    <li key={c.constraint}>
                      {c.constraint}: {c.detail}
                    </li>
                  ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium">3. Approval</h2>
        {!attempt && <p className="mt-2 text-sm text-slate-500">Select an eligible quote to build a merchant checkout.</p>}
        {attempt && (
          <div className="mt-3 space-y-2 text-sm">
            <p>
              {attempt.protocol.toUpperCase()} {attempt.protocol_version} checkout <span className="font-mono">{attempt.native_checkout_id}</span>
            </p>
            <p>
              Delivered total <strong>{money(attempt.snapshot.totals.total_minor, attempt.snapshot.currency)}</strong> (items {money(attempt.snapshot.totals.subtotal_minor)}, shipping {money(attempt.snapshot.totals.shipping_minor)}, tax {money(attempt.snapshot.totals.tax_minor)})
            </p>
            <ul className="text-slate-300">
              {attempt.snapshot.items.map((i) => (
                <li key={i.title}>
                  {i.quantity} × {i.title} · {money(i.total_minor)}
                </li>
              ))}
            </ul>
            <p className="font-mono text-xs text-slate-500">digest {attempt.snapshot_digest}</p>
            {approvals.map((a) => (
              <p key={a.id} className="text-xs text-slate-400">
                Approval {a.state} by {a.actor_id} {a.invalidation_reason ? `— ${a.invalidation_reason}` : ""}
              </p>
            ))}
            {request.status === "awaiting_approval" && (
              <button className="rounded-lg bg-sky-500 px-4 py-2 text-slate-950" disabled={!!busy} onClick={() => run("approve", () => api.approve(id, `ui-approve-${attempt.id}`))}>
                Approve these exact terms
              </button>
            )}
            {request.status === "approved" && (
              <button className="rounded-lg bg-amber-400 px-4 py-2 text-slate-950" disabled={!!busy} onClick={() => run("execute", () => api.execute(id, `ui-exec-${attempt.id}`))}>
                Reserve budget and complete checkout
              </button>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium">4. Order detail</h2>
        {receipt ? (
          <div className="mt-3 text-sm">
            <p>
              Order {receipt.order_references.native_order_id} via {receipt.order_references.protocol} · payment {receipt.payment_evidence.payment_state}
            </p>
            <p>Final {money(receipt.final_totals.total_minor, receipt.final_totals.currency)}</p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-500">Receipt appears after the merchant confirms a single order.</p>
        )}
        {attempt?.last_error && <p className="mt-2 text-sm text-amber-300">{attempt.last_error}</p>}
        {tl.budget && (
          <p className="mt-2 text-xs text-slate-400">
            {tl.budget.cost_center.name}: available {money(tl.budget.available_minor)} · reserved {money(tl.budget.active_reserved_minor)} · committed {money(tl.budget.cost_center.committed_minor)}
          </p>
        )}
        <ol className="mt-4 space-y-1 text-sm">
          {tl.workflow_events.map((e, i) => (
            <li key={i} className="font-mono text-xs text-slate-400">
              {when(e.created_at)} · {e.from_status ?? "∅"} → {e.to_status} — {e.reason}
            </li>
          ))}
        </ol>
        <h3 className="mt-6 text-sm font-medium text-slate-300">Protocol trace</h3>
        <ul className="mt-2 divide-y divide-slate-800 text-xs">
          {tl.protocol_events.map((e, i) => (
            <li key={i} className="py-2">
              <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setOpenEvent(openEvent === i ? null : i)}>
                <span className="font-mono text-slate-400">
                  {e.protocol} {e.direction} {e.operation}
                </span>
                <span className="text-slate-500">
                  {e.counterparty} {e.status ?? ""}
                </span>
              </button>
              {openEvent === i && <pre className="mt-2 overflow-auto rounded bg-slate-950 p-2 text-[11px] text-slate-300">{JSON.stringify(e.payload, null, 2)}</pre>}
            </li>
          ))}
        </ul>
      </section>

      {error && <p className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-100">{error}</p>}
    </div>
  );
}
