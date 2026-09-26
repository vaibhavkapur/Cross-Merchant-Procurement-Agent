import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { Express } from "express";
import { createLogger, ProtocolRecorder } from "@procurement/audit";
import { buildAdapters } from "@procurement/commerce-adapters";
import {
  ProcurementWorkflow,
  SqliteDriver,
  loadCompany,
  loadMerchants,
  loadSuppliers,
  merchantApiKey,
  migrate,
  seedDatabase,
  type MerchantFixture,
  type SupplierFixture,
} from "@procurement/domain";
import { buildCompanyMcp } from "../apps/company-mcp/src/server.ts";
import { buildSupplierAgent } from "../apps/supplier-a/src/server.ts";
import { buildMerchantUcp } from "../apps/merchant-ucp/src/server.ts";
import { buildMerchantAcp } from "../apps/merchant-acp/src/server.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { createRuntime, type Runtime } from "../apps/api/src/bootstrap.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { RecoveryWorker } from "../apps/worker/src/worker.ts";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

export async function listenExpress(app: Express, port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface TestStack {
  runtime: Runtime;
  app: FastifyInstance;
  worker: RecoveryWorker;
  urls: { api: string; mcp: string; supplierA: string; supplierB: string; merchantA: string; merchantB: string };
  token: string;
  close: () => Promise<void>;
}

export async function startStack(): Promise<TestStack> {
  const [mcpPort, saPort, sbPort, uaPort, abPort] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  const merchants = loadMerchants().map((m) => {
    if (m.id === "merchant_a") {
      return { ...m, base_url: `http://127.0.0.1:${uaPort}`, discovery_url: `http://127.0.0.1:${uaPort}/.well-known/ucp` };
    }
    return { ...m, base_url: `http://127.0.0.1:${abPort}`, discovery_url: `http://127.0.0.1:${abPort}/.well-known/acp-fixture-capabilities` };
  });
  const suppliers = loadSuppliers().map((s) => ({
    ...s,
    agent_url: s.id === "supplier_a" ? `http://127.0.0.1:${saPort}` : `http://127.0.0.1:${sbPort}`,
  }));
  const merchantA = merchants.find((m) => m.id === "merchant_a")!;
  const merchantB = merchants.find((m) => m.id === "merchant_b")!;
  const supplierA = suppliers.find((s) => s.id === "supplier_a")!;
  const supplierB = suppliers.find((s) => s.id === "supplier_b")!;

  const ucp = buildMerchantUcp({ merchant: merchantA, logger: false });
  const acp = buildMerchantAcp({ merchant: merchantB, logger: false });
  await ucp.listen({ port: uaPort, host: "127.0.0.1" });
  await acp.listen({ port: abPort, host: "127.0.0.1" });

  const sa = await listenExpress(buildSupplierAgent({ supplierId: "supplier_a", supplier: supplierA, merchant: merchantA, baseUrl: supplierA.agent_url }), saPort);
  const sb = await listenExpress(buildSupplierAgent({ supplierId: "supplier_b", supplier: supplierB, merchant: merchantB, baseUrl: supplierB.agent_url }), sbPort);
  const mcp = await listenExpress(buildCompanyMcp(), mcpPort);

  const dir = mkdtempSync(join(tmpdir(), "proc-"));
  const driver = new SqliteDriver(join(dir, "test.db"));
  await migrate(driver);
  const apiPort = await freePort();
  const config = loadConfig();
  config.merchants = merchants;
  config.suppliers = suppliers;
  config.companyMcpUrl = `${mcp.url}/mcp`;
  config.platformProfileUrl = `http://127.0.0.1:${apiPort}/.well-known/ucp`;
  const runtime = await createRuntime(config, { driver, logger: createLogger({ svc: "test" }) });
  const app = await buildApp({ runtime, logger: false });
  await app.listen({ port: apiPort, host: "127.0.0.1" });
  const worker = new RecoveryWorker({ workflow: runtime.workflow, pollMs: 80, logger: runtime.logger });
  worker.start();

  const company = loadCompany();
  return {
    runtime,
    app,
    worker,
    urls: { api: `http://127.0.0.1:${apiPort}`, mcp: mcp.url, supplierA: sa.url, supplierB: sb.url, merchantA: merchantA.base_url, merchantB: merchantB.base_url },
    token: company.principals[0]!.token,
    close: async () => {
      worker.stop();
      await app.close();
      await ucp.close();
      await acp.close();
      await sa.close();
      await sb.close();
      await mcp.close();
      await driver.close();
    },
  };
}

export async function memoryWorkflow(merchants?: MerchantFixture[], suppliers?: SupplierFixture[]) {
  const driver = new SqliteDriver(":memory:");
  await migrate(driver);
  const company = await seedDatabase(driver);
  const recorder = new ProtocolRecorder(() => new Date(), 50);
  const adapters = buildAdapters({
    merchants: merchants ?? loadMerchants(),
    apiKeyFor: (m) => merchantApiKey(loadMerchants().find((x) => x.id === m.id) ?? (m as MerchantFixture)),
    recorder,
    platformProfileUrl: "http://127.0.0.1:4000/.well-known/ucp",
  });
  const workflow = new ProcurementWorkflow({
    driver,
    adapters,
    merchants: merchants ?? loadMerchants(),
    suppliers: suppliers ?? loadSuppliers(),
    destinations: company.destinations,
    policyFor: () => company.policy,
    recorder,
    logger: createLogger({ svc: "test" }),
    clock: () => new Date(),
    paymentCredentialRef: company.payment_credential_ref,
  });
  return { driver, workflow, company, recorder };
}

export const alice = () => loadCompany().principals[0]!;
export const bob = () => loadCompany().principals[1]!;
