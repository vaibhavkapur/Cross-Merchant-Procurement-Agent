/**
 * Company MCP server — inventory, purchasing policy, and approved vendors.
 *
 * Streamable HTTP transport (stateless). Bearer authentication identifies a
 * fixture principal; every tool call is scoped to that principal's organization.
 * Read access here does not grant purchasing authority (plan §7.B / §16).
 */
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLogger, type Logger } from "@procurement/audit";
import { loadCompany, type CompanyFixture, type FixturePrincipal } from "@procurement/domain";
import { approvedMerchantIds } from "@procurement/policy";

export interface CompanyMcpOptions {
  company?: CompanyFixture;
  logger?: Logger;
  tokens?: Map<string, FixturePrincipal>;
}

function principalFromRequest(req: Request, tokens: Map<string, FixturePrincipal>): FixturePrincipal | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return tokens.get(token) ?? null;
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> };
}

function createMcp(principal: FixturePrincipal, company: CompanyFixture): McpServer {
  const server = new McpServer({ name: "company-tools", version: "0.1.0" }, { capabilities: { tools: {} } });

  const assertOrg = (organizationId?: string) => {
    if (organizationId && organizationId !== principal.organization_id) {
      throw new Error("Principal does not belong to the requested organization");
    }
    return principal.organization_id;
  };

  server.registerTool(
    "get_inventory",
    {
      title: "Get inventory",
      description: "Read on-hand stock for a product category. Read permission does not imply purchase permission.",
      inputSchema: z.object({
        product_category: z.string().min(1),
        organization_id: z.string().optional(),
      }),
    },
    async (args) => {
      assertOrg(args.organization_id);
      const items = company.inventory.filter((i) => i.category.toLowerCase() === args.product_category.toLowerCase());
      return jsonResult({
        organization_id: principal.organization_id,
        product_category: args.product_category,
        items,
        fixture: true,
      });
    },
  );

  server.registerTool(
    "get_purchasing_policy",
    {
      title: "Get purchasing policy",
      description: "Return the organization's purchasing policy for a cost centre. Policy is advisory input; the purchasing service decides whether an action is allowed.",
      inputSchema: z.object({
        cost_center: z.string().min(1),
        organization_id: z.string().optional(),
      }),
    },
    async (args) => {
      assertOrg(args.organization_id);
      const cc = company.cost_centers.find((c) => c.id === args.cost_center);
      return jsonResult({
        organization_id: principal.organization_id,
        cost_center: cc ?? null,
        policy: company.policy,
        caller: { id: principal.id, can_purchase: principal.can_purchase, roles: principal.roles },
        fixture: true,
      });
    },
  );

  server.registerTool(
    "list_approved_vendors",
    {
      title: "List approved vendors",
      description: "Vendors approved for a product category. Listing a vendor is not authorization to buy from them.",
      inputSchema: z.object({
        product_category: z.string().min(1),
        organization_id: z.string().optional(),
      }),
    },
    async (args) => {
      assertOrg(args.organization_id);
      const vendors = company.policy.approved_vendors.filter((v) => v.categories.includes(args.product_category));
      return jsonResult({
        organization_id: principal.organization_id,
        product_category: args.product_category,
        merchant_ids: approvedMerchantIds(company.policy, args.product_category),
        vendors,
        fixture: true,
      });
    },
  );

  return server;
}

export function buildCompanyMcp(opts: CompanyMcpOptions = {}): Express {
  const company = opts.company ?? loadCompany();
  const logger = opts.logger ?? createLogger({ svc: "company-mcp" });
  const tokens = opts.tokens ?? new Map(company.principals.map((p) => [p.token, p]));
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "company-mcp", organization_id: company.organization.id });
  });

  const handle = async (req: Request, res: Response) => {
    const principal = principalFromRequest(req, tokens);
    if (!principal) {
      res.status(401).json({ error: "unauthorized", message: "Bearer token required" });
      return;
    }
    const server = createMcp(principal, company);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  app.post("/mcp", (req, res) => {
    handle(req, res).catch((err) => {
      logger.error("mcp_request_failed", { error: String(err) });
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    });
  });
  app.get("/mcp", handle);
  app.delete("/mcp", handle);

  return app;
}
