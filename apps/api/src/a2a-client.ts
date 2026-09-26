import { ClientFactory, type Client } from "@a2a-js/sdk/client";
import { Role, type AgentCard, type Message, type Task } from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";
import type { ProtocolRecorder } from "@procurement/audit";
import type { SimulationFlags, Supplier } from "@procurement/domain";
import { A2A_QUOTE_MEDIA_TYPE, A2A_RFQ_MEDIA_TYPE, type RfqRequest } from "@procurement/protocol-contracts";

export interface SupplierQuoteResult {
  supplier_id: string;
  agent_card: AgentCard | null;
  task_id: string | null;
  context_id: string | null;
  native_status: string;
  artifact: unknown | null;
  error: string | null;
}

const factory = new ClientFactory();

function isTask(value: Message | Task): value is Task {
  return Array.isArray((value as Task).artifacts);
}

function extractArtifact(result: Message | Task): unknown | null {
  if (isTask(result)) {
    for (const art of result.artifacts) {
      for (const part of art.parts) {
        if (part.content?.$case === "data") return part.content.value;
        if (part.content?.$case === "text") {
          try {
            return JSON.parse(part.content.value);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  for (const part of (result as Message).parts ?? []) {
    if (part.content?.$case === "data") return part.content.value;
  }
  return null;
}

export async function solicitSupplierQuote(opts: {
  supplier: Supplier;
  rfq: RfqRequest;
  simulation: SimulationFlags;
  timeoutMs: number;
  procurementRequestId: string;
  traceId: string;
  recorder: ProtocolRecorder;
}): Promise<SupplierQuoteResult> {
  const { supplier, rfq, recorder } = opts;
  await recorder.record({
    procurement_request_id: opts.procurementRequestId,
    trace_id: opts.traceId,
    protocol: "a2a",
    direction: "outbound",
    operation: "agent-card.get",
    version: "1.0",
    counterparty: supplier.id,
    payload: { url: `${supplier.agent_url}/.well-known/agent-card.json` },
  });

  let client: Client;
  let card: AgentCard;
  try {
    client = await factory.createFromUrl(supplier.agent_url);
    card = (await (client as unknown as { getAgentCard?: () => Promise<AgentCard> }).getAgentCard?.()) ?? (await discoverCard(supplier.agent_url));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recorder.record({
      procurement_request_id: opts.procurementRequestId,
      trace_id: opts.traceId,
      protocol: "a2a",
      direction: "inbound",
      operation: "agent-card.get",
      version: "1.0",
      counterparty: supplier.id,
      status: "error",
      payload: { error },
    });
    return { supplier_id: supplier.id, agent_card: null, task_id: null, context_id: null, native_status: "failed", artifact: null, error };
  }

  await recorder.record({
    procurement_request_id: opts.procurementRequestId,
    trace_id: opts.traceId,
    protocol: "a2a",
    direction: "inbound",
    operation: "agent-card.get",
    version: "1.0",
    counterparty: supplier.id,
    status: "ok",
    payload: { name: card.name, skills: card.skills.map((s) => s.id), interfaces: card.supportedInterfaces },
  });

  await recorder.record({
    procurement_request_id: opts.procurementRequestId,
    trace_id: opts.traceId,
    protocol: "a2a",
    direction: "outbound",
    operation: "message/send",
    version: "1.0",
    counterparty: supplier.id,
    payload: { rfq, media_type: A2A_RFQ_MEDIA_TYPE },
  });

  try {
    const result = await client.sendMessage(
      {
        tenant: "",
        message: {
          messageId: randomUUID(),
          contextId: "",
          taskId: "",
          role: Role.ROLE_USER,
          parts: [{ content: { $case: "data", value: rfq }, metadata: { contract: rfq.contract }, filename: "rfq.json", mediaType: A2A_RFQ_MEDIA_TYPE }],
          metadata: { simulation: opts.simulation },
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: {
          acceptedOutputModes: [A2A_QUOTE_MEDIA_TYPE, "application/json"],
          taskPushNotificationConfig: undefined,
          returnImmediately: false,
        },
        metadata: { simulation: opts.simulation },
      },
      { signal: AbortSignal.timeout(opts.timeoutMs) },
    );
    const artifact = extractArtifact(result);
    const task = isTask(result) ? result : null;
    await recorder.record({
      procurement_request_id: opts.procurementRequestId,
      trace_id: opts.traceId,
      protocol: "a2a",
      direction: "inbound",
      operation: "message/send",
      version: "1.0",
      counterparty: supplier.id,
      status: task?.status?.state !== undefined ? String(task.status.state) : "ok",
      payload: { task_id: task?.id ?? null, artifact },
    });
    return {
      supplier_id: supplier.id,
      agent_card: card,
      task_id: task?.id ?? null,
      context_id: task?.contextId ?? null,
      native_status: task ? String(task.status?.state ?? "completed") : "completed",
      artifact,
      error: artifact ? null : "supplier returned no quote artifact",
    };
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await recorder.record({
      procurement_request_id: opts.procurementRequestId,
      trace_id: opts.traceId,
      protocol: "a2a",
      direction: "inbound",
      operation: "message/send",
      version: "1.0",
      counterparty: supplier.id,
      status: "timeout_or_error",
      payload: { error },
    });
    return { supplier_id: supplier.id, agent_card: card, task_id: null, context_id: null, native_status: "timeout", artifact: null, error };
  }
}

async function discoverCard(baseUrl: string): Promise<AgentCard> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/.well-known/agent-card.json`);
  if (!res.ok) throw new Error(`agent card HTTP ${res.status}`);
  return (await res.json()) as AgentCard;
}
