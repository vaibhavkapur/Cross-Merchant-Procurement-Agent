import { createHash } from "node:crypto";
import type { ProtocolRecorder } from "@procurement/audit";
import type { Merchant } from "@procurement/domain";

export class TransportError extends Error {
  readonly kind: "timeout" | "network" | "protocol";
  constructor(kind: "timeout" | "network" | "protocol", message: string) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
  }
}

export class NotAllowedError extends Error {
  constructor(url: string) {
    super(`Refusing to contact ${url}: not an approved merchant endpoint`);
    this.name = "NotAllowedError";
  }
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  raw_text: string;
}

export interface ProtocolHttpOptions {
  recorder: ProtocolRecorder;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Allow-listed HTTP client used by every adapter. Only origins that belong to
 * an approved merchant (its base URL or discovery URL) may be contacted; every
 * request/response pair is recorded (redacted) as a protocol event.
 */
export class ProtocolHttp {
  private readonly recorder: ProtocolRecorder;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly allowedOrigins = new Set<string>();

  constructor(merchants: Merchant[], opts: ProtocolHttpOptions) {
    this.recorder = opts.recorder;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    for (const m of merchants) {
      this.allowedOrigins.add(new URL(m.base_url).origin);
      this.allowedOrigins.add(new URL(m.discovery_url).origin);
    }
  }

  isAllowed(url: string): boolean {
    try {
      return this.allowedOrigins.has(new URL(url).origin);
    } catch {
      return false;
    }
  }

  async call(args: {
    protocol: "ucp" | "acp";
    version: string;
    operation: string;
    merchant_id: string;
    procurement_request_id: string | null;
    trace_id: string;
    method: "GET" | "POST" | "PUT";
    url: string;
    headers: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<HttpResult> {
    if (!this.isAllowed(args.url)) throw new NotAllowedError(args.url);
    const common = { procurement_request_id: args.procurement_request_id, trace_id: args.trace_id, protocol: args.protocol, version: args.version, counterparty: args.merchant_id };
    await this.recorder.record({ ...common, direction: "outbound", operation: args.operation, payload: { method: args.method, url: args.url, headers: args.headers, body: args.body ?? null } });
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(args.url, {
        method: args.method,
        headers: { accept: "application/json", ...(args.body !== undefined ? { "content-type": "application/json" } : {}), ...args.headers },
        body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
        signal: AbortSignal.timeout(args.timeoutMs ?? this.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const message = err instanceof Error ? `${err.name}: ${err.message}${(err as { cause?: { code?: string } }).cause?.code ? ` (${(err as { cause?: { code?: string } }).cause?.code})` : ""}` : String(err);
      await this.recorder.record({ ...common, direction: "inbound", operation: args.operation, status: isTimeout ? "timeout" : "transport_error", payload: { error: message } });
      throw new TransportError(isTimeout ? "timeout" : "network", message);
    }
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { _raw: text.slice(0, 2000) };
      }
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    await this.recorder.record({ ...common, direction: "inbound", operation: args.operation, status: String(res.status), payload: { status: res.status, headers, body } });
    return { status: res.status, headers, body, raw_text: text };
  }
}

/** Deterministic RFC 4122-shaped identifier derived from an application key (UCP wants uuid-formatted keys). */
export function keyToUuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  const v = `4${h.slice(13, 16)}`;
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}-${h.slice(20, 32)}`;
}

/**
 * Fixture payment vault. The agent only ever holds an opaque reference; the
 * vault (in production a PCI-scoped service) exchanges it for a single-use
 * token the merchant's payment handler understands.
 */
export function resolvePaymentToken(credentialRef: string, attemptId: string): string {
  return `tok_fixture_${createHash("sha256").update(`${credentialRef}|${attemptId}`).digest("hex").slice(0, 24)}`;
}
