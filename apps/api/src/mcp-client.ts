import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ProtocolRecorder } from "@procurement/audit";

export interface CompanyTools {
  inventory: unknown;
  policy: unknown;
  vendors: unknown;
  discovered_tools: string[];
}

export async function callCompanyTools(opts: {
  url: string;
  token: string;
  productCategory: string;
  costCenter: string;
  organizationId: string;
  procurementRequestId: string | null;
  traceId: string;
  recorder: ProtocolRecorder;
}): Promise<CompanyTools> {
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
    requestInit: { headers: { authorization: `Bearer ${opts.token}` } },
  });
  const client = new Client({ name: "procurement-api", version: "0.1.0" });
  await opts.recorder.record({
    procurement_request_id: opts.procurementRequestId,
    trace_id: opts.traceId,
    protocol: "mcp",
    direction: "outbound",
    operation: "initialize",
    version: "2025-06-18",
    counterparty: "company-mcp",
    payload: { url: opts.url },
  });
  await client.connect(transport);
  const listed = await client.listTools();
  const discovered_tools = listed.tools.map((t) => t.name);
  await opts.recorder.record({
    procurement_request_id: opts.procurementRequestId,
    trace_id: opts.traceId,
    protocol: "mcp",
    direction: "inbound",
    operation: "tools/list",
    version: "2025-06-18",
    counterparty: "company-mcp",
    status: "ok",
    payload: { tools: discovered_tools },
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    await opts.recorder.record({
      procurement_request_id: opts.procurementRequestId,
      trace_id: opts.traceId,
      protocol: "mcp",
      direction: "outbound",
      operation: `tools/call:${name}`,
      version: "2025-06-18",
      counterparty: "company-mcp",
      payload: { name, arguments: args },
    });
    const result = await client.callTool({ name, arguments: args });
    await opts.recorder.record({
      procurement_request_id: opts.procurementRequestId,
      trace_id: opts.traceId,
      protocol: "mcp",
      direction: "inbound",
      operation: `tools/call:${name}`,
      version: "2025-06-18",
      counterparty: "company-mcp",
      status: "ok",
      payload: result,
    });
    return result.structuredContent ?? result;
  };

  try {
    const [inventory, policy, vendors] = await Promise.all([
      call("get_inventory", { product_category: opts.productCategory, organization_id: opts.organizationId }),
      call("get_purchasing_policy", { cost_center: opts.costCenter, organization_id: opts.organizationId }),
      call("list_approved_vendors", { product_category: opts.productCategory, organization_id: opts.organizationId }),
    ]);
    return { inventory, policy, vendors, discovered_tools };
  } finally {
    await client.close().catch(() => undefined);
  }
}
