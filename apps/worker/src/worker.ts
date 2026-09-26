import { randomUUID } from "node:crypto";
import { createLogger, type Logger } from "@procurement/audit";
import { iso, type ProcurementWorkflow } from "@procurement/domain";

export interface WorkerOptions {
  workflow: ProcurementWorkflow;
  workerId?: string;
  pollMs?: number;
  staleMs?: number;
  logger?: Logger;
}

export class RecoveryWorker {
  private readonly workflow: ProcurementWorkflow;
  private readonly workerId: string;
  private readonly pollMs: number;
  private readonly staleMs: number;
  private readonly logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(opts: WorkerOptions) {
    this.workflow = opts.workflow;
    this.workerId = opts.workerId ?? `wrk_${randomUUID().slice(0, 8)}`;
    this.pollMs = opts.pollMs ?? 400;
    this.staleMs = opts.staleMs ?? 15_000;
    this.logger = opts.logger ?? createLogger({ svc: "worker" });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error("tick_failed", { error: String(err) }));
    }, this.pollMs);
    this.logger.info("worker_started", { worker_id: this.workerId });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      await this.workflow.expireStale();
      const now = this.workflow.clock();
      const claimed = await this.workflow.store.claimOutbox(this.workerId, iso(now), iso(new Date(now.getTime() - this.staleMs)));
      for (const msg of claimed) {
        try {
          if (msg.kind === "execute_checkout") {
            const attemptId = String(msg.payload.attempt_id ?? msg.aggregate_id);
            const traceId = String(msg.payload.trace_id ?? `trc_${this.workerId}`);
            await this.workflow.runExecution(attemptId, traceId);
            await this.workflow.store.completeOutbox(msg.id, iso(this.workflow.clock()));
          } else if (msg.kind === "reconcile_attempt") {
            const attemptId = String(msg.payload.attempt_id ?? msg.aggregate_id);
            const traceId = String(msg.payload.trace_id ?? `trc_${this.workerId}`);
            const probes = Math.max(0, msg.attempts - 1);
            const resolved = await this.workflow.runReconciliation(attemptId, traceId, probes);
            if (resolved) {
              await this.workflow.store.completeOutbox(msg.id, iso(this.workflow.clock()));
            } else {
              const retryAt = iso(new Date(this.workflow.clock().getTime() + 1_500));
              await this.workflow.store.failOutbox(msg.id, `still unknown after probe ${probes + 1}`, retryAt);
            }
          }
        } catch (err) {
          const retryAt = iso(new Date(this.workflow.clock().getTime() + 2_000));
          await this.workflow.store.failOutbox(msg.id, err instanceof Error ? err.message : String(err), retryAt);
          this.logger.error("outbox_handler_failed", { id: msg.id, kind: msg.kind, error: String(err) });
        }
      }
      return claimed.length;
    } finally {
      this.ticking = false;
    }
  }
}
