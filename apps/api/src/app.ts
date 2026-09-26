import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { newTraceId } from "@procurement/audit";
import { platformUcpProfile } from "@procurement/commerce-adapters";
import { DomainError, digestOf, type CapabilitySnapshot, type FixturePrincipal, type IntentDraft, type SimulationFlags } from "@procurement/domain";
import { PolicyError } from "@procurement/policy";
import { RFQ_CONTRACT, type RfqRequest } from "@procurement/protocol-contracts";
import { solicitSupplierQuote } from "./a2a-client.ts";
import type { Runtime } from "./bootstrap.ts";
import { applySimulation, extractIntent } from "./intent.ts";
import { callCompanyTools } from "./mcp-client.ts";

export interface BuildAppOptions {
  runtime: Runtime;
  logger?: boolean;
}

interface AuthRequest extends FastifyRequest {
  principal: FixturePrincipal;
  traceId: string;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function errorBody(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof DomainError) return { status: err.status, body: { error: err.code, message: err.message, details: err.details ?? null } };
  if (err instanceof PolicyError) return { status: err.status, body: { error: err.code, message: err.message, details: err.details ?? null } };
  return { status: 500, body: { error: "internal_error", message: err instanceof Error ? err.message : String(err) } };
}

function tokenOf(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim();
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { runtime } = opts;
  const { config, workflow, store, recorder } = runtime;
  const tokens = new Map(config.company.principals.map((p) => [p.token, p]));
  const quoteLatency: number[] = [];
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: true });

  app.decorateRequest("principal", null);
  app.decorateRequest("traceId", "");

  app.addHook("preHandler", async (req, reply) => {
    (req as AuthRequest).traceId = typeof req.headers["x-trace-id"] === "string" ? req.headers["x-trace-id"] : newTraceId();
    if (req.url.startsWith("/healthz") || req.url.startsWith("/.well-known/")) return;
    const token = tokenOf(req);
    const principal = token ? tokens.get(token) : undefined;
    if (!principal) {
      return reply.code(401).send({ error: "unauthorized", message: "Bearer token required" });
    }
    (req as AuthRequest).principal = principal;
  });

  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = errorBody(err);
    runtime.logger.error("request_failed", { error: body.error, message: body.message });
    reply.code(status).send(body);
  });

  const idempotent = async (req: AuthRequest, reply: FastifyReply, handler: () => Promise<{ status: number; body: unknown }>) => {
    if (!MUTATING.has(req.method)) return handler().then((r) => reply.code(r.status).send(r.body));
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key) {
      return reply.code(400).send({ error: "idempotency_key_required", message: "Idempotency-Key header is required on mutating requests" });
    }
    const scope = `${req.principal.id}:${req.method}:${req.url}`;
    const hash = digestOf(req.body ?? null);
    const existing = await store.getIdempotency(scope, key);
    if (existing) {
      if (existing.request_hash !== hash) {
        return reply.code(409).send({ error: "idempotency_conflict", message: "Idempotency-Key was reused with a different request body" });
      }
      return reply.code(existing.status_code).header("Idempotent-Replayed", "true").send(existing.response);
    }
    const result = await handler();
    await store.putIdempotency(scope, key, hash, result.status, result.body, new Date().toISOString());
    return reply.code(result.status).send(result.body);
  };

  app.get("/healthz", async () => ({ ok: true, service: "api" }));

  app.get("/.well-known/ucp", async () => platformUcpProfile(config.platformProfileUrl));

  app.get("/v1/meta", async (req) => {
    const principal = (req as AuthRequest).principal;
    return {
      organization: config.company.organization,
      buyer: { id: principal.id, name: principal.name, roles: principal.roles, can_purchase: principal.can_purchase },
      cost_centers: config.company.cost_centers,
      destinations: config.company.destinations,
      suppliers: config.suppliers.map((s) => ({ id: s.id, name: s.name, merchant_id: s.merchant_id })),
      merchants: config.merchants.map((m) => ({ id: m.id, name: m.name, protocol: m.protocol })),
      scenarios: Object.fromEntries(Object.entries(config.scenarios).map(([k, v]) => [k, { title: v.title, text: v.text, expect: v.expect }])),
      fixtures_labelled: true,
    };
  });

  app.get("/v1/metrics", async () => {
    const sorted = [...quoteLatency].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
    const attempts = await store.countAttemptsByState();
    const approvals = await store.countApprovalsByState();
    return {
      quote_latency_ms: { n: sorted.length, p50: pct(50), p95: pct(95), sample: sorted },
      completion_outcomes: attempts,
      reconciliation_backlog: await store.pendingOutboxCount(),
      duplicate_attempts_prevented: attempts, // unique idempotency_key on attempts is the hard guarantee
      approval_invalidations: approvals.invalidated ?? 0,
      approval_states: approvals,
    };
  });

  app.post("/v1/intent/preview", async (req) => {
    const body = (req.body ?? {}) as { text?: string; scenario?: string; structured?: Parameters<typeof extractIntent>[0]["structured"] };
    const intent = extractIntent({ text: body.text, structured: body.structured, company: config.company, now: runtime.clock() });
    return { intent, simulation: applySimulation(body.scenario, undefined, config.scenarios) };
  });

  app.post("/v1/procurement-requests", async (req, reply) => {
    return idempotent(req as AuthRequest, reply, async () => {
      const principal = (req as AuthRequest).principal;
      const body = (req.body ?? {}) as {
        text?: string;
        scenario?: string;
        simulation?: SimulationFlags;
        cost_center_id?: string;
        product?: IntentDraft["product"];
        quantity?: number;
        currency?: string;
        budget_minor?: string | number;
        delivery_deadline?: string;
        destination_id?: string;
        allowed_merchants?: string[];
        source_text?: string;
      };
      const intent = extractIntent({
        text: body.text ?? body.source_text,
        structured: {
          cost_center_id: body.cost_center_id,
          product: body.product,
          quantity: body.quantity,
          currency: body.currency,
          budget_minor: body.budget_minor,
          delivery_deadline: body.delivery_deadline,
          destination_id: body.destination_id,
          allowed_merchants: body.allowed_merchants,
        },
        company: config.company,
        now: runtime.clock(),
      });
      const request = await workflow.createRequest({
        principal,
        intent,
        source_text: body.text ?? body.source_text ?? null,
        simulation: applySimulation(body.scenario, body.simulation, config.scenarios),
      });
      return { status: 201, body: { request, intent } };
    });
  });

  app.get("/v1/procurement-requests", async (req) => {
    const principal = (req as AuthRequest).principal;
    const requests = await store.listRequests(principal.organization_id);
    return { requests };
  });

  app.get("/v1/procurement-requests/:id", async (req) => {
    const principal = (req as AuthRequest).principal;
    const request = await workflow.getRequest((req.params as { id: string }).id, principal);
    return { request };
  });

  app.post("/v1/procurement-requests/:id/solicit-quotes", async (req, reply) => {
    return idempotent(req as AuthRequest, reply, async () => {
      const principal = (req as AuthRequest).principal;
      const traceId = (req as AuthRequest).traceId;
      const request = await workflow.getRequest((req.params as { id: string }).id, principal);
      const started = runtime.clock();
      let tools: unknown = null;
      try {
        tools = await callCompanyTools({
          url: config.companyMcpUrl,
          token: principal.token,
          productCategory: request.product_constraints.category,
          costCenter: request.cost_center_id,
          organizationId: request.organization_id,
          procurementRequestId: request.id,
          traceId,
          recorder,
        });
      } catch (err) {
        runtime.logger.warn("mcp_unavailable", { error: String(err) });
        await recorder.record({
          procurement_request_id: request.id,
          trace_id: traceId,
          protocol: "mcp",
          direction: "inbound",
          operation: "tools/call",
          status: "error",
          counterparty: "company-mcp",
          payload: { error: err instanceof Error ? err.message : String(err) },
        });
      }

      const dest = workflow.destination(request.destination_id);
      const deadline = new Date(runtime.clock().getTime() + 8_000).toISOString();
      const { tasks } = await workflow.beginQuoteCollection(request.id, principal, config.suppliers.map((s) => s.id), deadline);
      const rfqFor = (taskId: string): RfqRequest => ({
        contract: RFQ_CONTRACT,
        rfq_id: taskId,
        product: request.product_constraints,
        quantity: request.quantity,
        currency: request.currency,
        destination: {
          destination_id: dest.destination_id,
          country: dest.country,
          region: dest.region,
          locality: dest.locality,
          postal_code: dest.postal_code,
        },
        required_delivery_by: request.delivery_deadline,
        response_deadline: deadline,
      });

      const results = await Promise.all(
        tasks.map(async (task) => {
          const supplier = config.suppliers.find((s) => s.id === task.supplier_id);
          if (!supplier) return { task, error: "unknown supplier" };
          const result = await solicitSupplierQuote({
            supplier,
            rfq: rfqFor(task.id),
            simulation: request.simulation,
            timeoutMs: 4_000,
            procurementRequestId: request.id,
            traceId,
            recorder,
          });
          task.a2a_task_id = result.task_id;
          task.a2a_context_id = result.context_id;
          task.native_status = result.native_status;
          task.error = result.error;
          await workflow.updateSupplierTask(task);
          if (result.artifact) {
            try {
              await workflow.recordQuote(task, result.artifact);
            } catch (err) {
              task.error = err instanceof Error ? err.message : String(err);
              task.native_status = "failed";
              await workflow.updateSupplierTask(task);
            }
          }
          return result;
        }),
      );

      const capabilities: Record<string, CapabilitySnapshot | undefined> = {};
      for (const merchant of config.merchants) {
        try {
          capabilities[merchant.id] = await workflow.adapterFor(merchant.id).discover(merchant.id, traceId);
        } catch (err) {
          runtime.logger.warn("discover_failed", { merchant_id: merchant.id, error: String(err) });
        }
      }
      const quotes = await workflow.finishQuoteCollection(request.id, principal, capabilities);
      quoteLatency.push(runtime.clock().getTime() - started.getTime());
      const latest = await workflow.getRequest(request.id, principal);
      return { status: 200, body: { request: latest, quotes, company_tools: tools, supplier_results: results.map((r) => ("supplier_id" in r ? { supplier_id: r.supplier_id, native_status: r.native_status, error: r.error } : r)) } };
    });
  });

  app.get("/v1/procurement-requests/:id/quotes", async (req) => {
    const principal = (req as AuthRequest).principal;
    const request = await workflow.getRequest((req.params as { id: string }).id, principal);
    const quotes = await store.listQuotes(request.id);
    return { request, quotes };
  });

  app.post("/v1/procurement-requests/:id/select-quote", async (req, reply) => {
    return idempotent(req as AuthRequest, reply, async () => {
      const principal = (req as AuthRequest).principal;
      const body = (req.body ?? {}) as { quote_id?: string };
      if (!body.quote_id) return { status: 400, body: { error: "quote_id_required", message: "quote_id is required" } };
      const result = await workflow.selectQuote((req.params as { id: string }).id, body.quote_id, principal, (req as AuthRequest).traceId);
      return { status: 200, body: result };
    });
  });

  app.post("/v1/procurement-requests/:id/approve", async (req, reply) => {
    return idempotent(req as AuthRequest, reply, async () => {
      const result = await workflow.approve((req.params as { id: string }).id, (req as AuthRequest).principal, (req as AuthRequest).traceId);
      return { status: 200, body: result };
    });
  });

  app.post("/v1/procurement-requests/:id/execute", async (req, reply) => {
    return idempotent(req as AuthRequest, reply, async () => {
      const result = await workflow.execute((req.params as { id: string }).id, (req as AuthRequest).principal, (req as AuthRequest).traceId);
      return { status: 200, body: result };
    });
  });

  app.get("/v1/procurement-requests/:id/timeline", async (req) => {
    return workflow.timeline((req.params as { id: string }).id, (req as AuthRequest).principal);
  });

  app.get("/v1/procurement-requests/:id/receipt", async (req) => {
    const receipt = await workflow.receipt((req.params as { id: string }).id, (req as AuthRequest).principal);
    return { receipt };
  });

  app.post("/v1/procurement-requests/:id/cancel", async (req, reply) => {
    return idempotent(req as AuthRequest, reply, async () => {
      const body = (req.body ?? {}) as { reason?: string };
      const request = await workflow.cancel((req.params as { id: string }).id, (req as AuthRequest).principal, body.reason ?? "cancelled by buyer");
      return { status: 200, body: { request } };
    });
  });

  return app;
}

export type { Runtime };
