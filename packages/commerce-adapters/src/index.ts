import type { ProtocolRecorder } from "@procurement/audit";
import type { CommerceAdapter, Merchant } from "@procurement/domain";
import type { MerchantProtocol } from "@procurement/protocol-contracts";
import { AcpAdapter } from "./acp.ts";
import { ProtocolHttp } from "./http.ts";
import { UcpAdapter } from "./ucp.ts";

export * from "./http.ts";
export * from "./acp.ts";
export * from "./ucp.ts";

export interface AdapterSetOptions {
  merchants: Merchant[];
  apiKeyFor: (merchant: Merchant) => string;
  recorder: ProtocolRecorder;
  platformProfileUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  clock?: () => Date;
}

/** Build one adapter per protocol sharing an allow-listed, recorded HTTP client. */
export function buildAdapters(opts: AdapterSetOptions): Partial<Record<MerchantProtocol, CommerceAdapter>> {
  const http = new ProtocolHttp(opts.merchants, { recorder: opts.recorder, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
  return {
    acp: new AcpAdapter({ merchants: opts.merchants, apiKeyFor: opts.apiKeyFor, http, clock: opts.clock }),
    ucp: new UcpAdapter({ merchants: opts.merchants, apiKeyFor: opts.apiKeyFor, http, platformProfileUrl: opts.platformProfileUrl, clock: opts.clock }),
  };
}
