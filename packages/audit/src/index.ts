import { randomUUID } from "node:crypto";

/** Header / field names whose values must never be persisted or logged in clear. */
const SENSITIVE_KEY = /(authorization|api[-_]?key|token|secret|credential|password|cookie|set-cookie|payment_data|card|cvv|pan)/i;
const BEARER_VALUE = /^Bearer\s+\S+/i;

/**
 * Deep-copies `value` replacing sensitive members with `[REDACTED]`. Keys are
 * matched case-insensitively; string values that look like bearer tokens are
 * also masked regardless of key name.
 */
export function redact<T>(value: T): T {
  return walk(value, 0) as T;
}

function walk(value: unknown, depth: number): unknown {
  if (depth > 32) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = v === null || v === undefined ? v : "[REDACTED]";
      } else {
        out[k] = walk(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string" && BEARER_VALUE.test(value)) return "Bearer [REDACTED]";
  return value;
}

export function newTraceId(): string {
  return `trc_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export type Protocol = "mcp" | "a2a" | "ucp" | "acp" | "app";
export type Direction = "outbound" | "inbound" | "internal";

export interface ProtocolEventInput {
  procurement_request_id: string | null;
  trace_id: string;
  protocol: Protocol;
  direction: Direction;
  operation: string;
  version?: string | null;
  counterparty?: string | null;
  status?: string | null;
  payload: unknown;
}

export interface RecordedProtocolEvent extends ProtocolEventInput {
  id: string;
  version: string | null;
  counterparty: string | null;
  status: string | null;
  created_at: string;
}

export type ProtocolEventSink = (event: RecordedProtocolEvent) => Promise<void> | void;

/**
 * Records every cross-protocol message (redacted) with a trace id so the API
 * timeline can show the exact native payloads exchanged for a request.
 */
export class ProtocolRecorder {
  private readonly sinks: ProtocolEventSink[] = [];
  private readonly buffer: RecordedProtocolEvent[] = [];
  private readonly clock: () => Date;
  private readonly keepInMemory: number;
  constructor(clock: () => Date = () => new Date(), keepInMemory = 0) {
    this.clock = clock;
    this.keepInMemory = keepInMemory;
  }

  addSink(sink: ProtocolEventSink): void {
    this.sinks.push(sink);
  }

  async record(input: ProtocolEventInput): Promise<RecordedProtocolEvent> {
    const event: RecordedProtocolEvent = {
      ...input,
      id: `pev_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      version: input.version ?? null,
      counterparty: input.counterparty ?? null,
      status: input.status ?? null,
      payload: redact(input.payload),
      created_at: this.clock().toISOString(),
    };
    if (this.keepInMemory > 0) {
      this.buffer.push(event);
      if (this.buffer.length > this.keepInMemory) this.buffer.shift();
    }
    for (const sink of this.sinks) {
      try {
        await sink(event);
      } catch (err) {
        logJson("error", "protocol_event_sink_failed", { error: String(err) });
      }
    }
    return event;
  }

  recent(): RecordedProtocolEvent[] {
    return [...this.buffer];
  }
}

// ---------------------------------------------------------------------------
// Structured logging (JSON lines to stdout; redacted)
// ---------------------------------------------------------------------------
export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function logJson(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const line = { ts: new Date().toISOString(), level, msg, ...redact(fields) };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(base: Record<string, unknown>): Logger;
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  const make = (ctx: Record<string, unknown>): Logger => ({
    debug: (m, f) => logJson("debug", m, { ...ctx, ...f }),
    info: (m, f) => logJson("info", m, { ...ctx, ...f }),
    warn: (m, f) => logJson("warn", m, { ...ctx, ...f }),
    error: (m, f) => logJson("error", m, { ...ctx, ...f }),
    child: (more) => make({ ...ctx, ...more }),
  });
  return make(base);
}
