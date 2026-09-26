import { createLogger, ProtocolRecorder, type Logger } from "@procurement/audit";
import { buildAdapters, platformUcpProfile } from "@procurement/commerce-adapters";
import {
  openDatabase,
  seedDatabase,
  ProcurementWorkflow,
  Store,
  systemClock,
  type SqlDriver,
  type Clock,
} from "@procurement/domain";
import type { ServiceConfig } from "./config.ts";
import { apiKeyFor } from "./config.ts";

export interface Runtime {
  config: ServiceConfig;
  driver: SqlDriver;
  store: Store;
  workflow: ProcurementWorkflow;
  recorder: ProtocolRecorder;
  logger: Logger;
  clock: Clock;
}

export async function createRuntime(config: ServiceConfig, opts: { driver?: SqlDriver; clock?: Clock; logger?: Logger } = {}): Promise<Runtime> {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? createLogger({ svc: "api" });
  const driver = opts.driver ?? (await openDatabase());
  await seedDatabase(driver);
  const store = new Store(driver);
  const recorder = new ProtocolRecorder(clock);
  recorder.addSink(async (event) => {
    await store.insertProtocolEvent({
      id: event.id,
      procurement_request_id: event.procurement_request_id,
      trace_id: event.trace_id,
      protocol: event.protocol,
      direction: event.direction,
      operation: event.operation,
      version: event.version,
      counterparty: event.counterparty,
      status: event.status,
      payload: event.payload,
      created_at: event.created_at,
    });
  });
  const adapters = buildAdapters({
    merchants: config.merchants,
    apiKeyFor,
    recorder,
    platformProfileUrl: config.platformProfileUrl,
    clock,
  });
  const workflow = new ProcurementWorkflow({
    driver,
    adapters,
    merchants: config.merchants,
    suppliers: config.suppliers,
    destinations: config.company.destinations,
    policyFor: () => config.company.policy,
    recorder,
    logger,
    clock,
    paymentCredentialRef: config.paymentCredentialRef,
    ranking: { criteria: ["delivered_cost", "delivery_buffer", "preferred_merchant"], preferred_merchants: config.company.policy.approved_vendors.sort((a, b) => a.preference_rank - b.preference_rank).map((v) => v.merchant_id) },
  });
  return { config, driver, store, workflow, recorder, logger, clock };
}

export { platformUcpProfile };
