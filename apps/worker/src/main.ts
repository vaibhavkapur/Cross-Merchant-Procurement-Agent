import { createLogger } from "@procurement/audit";
import { loadConfig } from "../../api/src/config.ts";
import { createRuntime } from "../../api/src/bootstrap.ts";
import { RecoveryWorker } from "./worker.ts";

const logger = createLogger({ svc: "worker" });
const runtime = await createRuntime(loadConfig(), { logger });
const worker = new RecoveryWorker({ workflow: runtime.workflow, logger, pollMs: Number(process.env.WORKER_POLL_MS ?? 400) });
worker.start();
logger.info("recovery_worker_ready");
