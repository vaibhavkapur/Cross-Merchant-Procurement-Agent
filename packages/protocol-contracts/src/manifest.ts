/**
 * Specification manifest: which protocol releases this build is pinned to,
 * where they came from, and the operations each adapter relies on.
 * `scripts/spec-manifest.ts` adds SHA-256 digests of the vendored files.
 */
import { ACP_API_VERSION, ACP_OPENAPI_PATH, ACP_SCHEMA_PATH, ACP_EXAMPLES_PATH } from "./acp.ts";
import { UCP_REST_OPENAPI_PATH, UCP_SCHEMA_ROOT, UCP_VERSION } from "./ucp.ts";
import { listVendoredFiles, sha256OfVendoredFile } from "./vendor.ts";

export interface SpecEntry {
  protocol: string;
  role: string;
  version: string;
  specification_url: string;
  source_repository: string;
  immutable_revision: string;
  sdk?: string;
  vendored_files: string[];
  operations: string[];
  notes: string[];
}

export const SPEC_MANIFEST: SpecEntry[] = [
  {
    protocol: "MCP",
    role: "Company tools (inventory, purchasing policy, approved vendors)",
    version: "2025-06-18 (protocol revision negotiated by SDK)",
    specification_url: "https://modelcontextprotocol.io/docs/learn/architecture",
    source_repository: "https://github.com/modelcontextprotocol/typescript-sdk",
    immutable_revision: "npm @modelcontextprotocol/sdk@1.30.1",
    sdk: "@modelcontextprotocol/sdk 1.30.x (Streamable HTTP transport)",
    vendored_files: [],
    operations: ["initialize", "tools/list", "tools/call"],
    notes: ["Bearer token authentication; organization scoping enforced server-side per tool call."],
  },
  {
    protocol: "A2A",
    role: "Supplier quotation tasks",
    version: "1.0",
    specification_url: "https://a2a-protocol.org/latest/topics/key-concepts/",
    source_repository: "https://github.com/a2aproject/a2a-js",
    immutable_revision: "npm @a2a-js/sdk@1.2.1",
    sdk: "@a2a-js/sdk 1.2.x (JSON-RPC transport)",
    vendored_files: [],
    operations: ["GET /.well-known/agent-card.json", "message/send (blocking)", "tasks/get"],
    notes: ["RFQ and quote payloads are application contracts (procurement.rfq.v1 / procurement.quote.v1) carried as A2A data parts."],
  },
  {
    protocol: "UCP",
    role: "Merchant A checkout (REST binding, checkout + fulfillment capabilities)",
    version: UCP_VERSION,
    specification_url: "https://ucp.dev/specification/overview/",
    source_repository: "https://github.com/Universal-Commerce-Protocol/ucp",
    immutable_revision: "git tag v2026-08-25 (source/schemas, services/shopping/rest.openapi.json)",
    vendored_files: [...listVendoredFiles(UCP_SCHEMA_ROOT), UCP_REST_OPENAPI_PATH],
    operations: [
      "GET /.well-known/ucp (business profile)",
      "POST /checkout-sessions",
      "GET /checkout-sessions/{id}",
      "PUT /checkout-sessions/{id}",
      "POST /checkout-sessions/{id}/complete",
      "POST /checkout-sessions/{id}/cancel",
    ],
    notes: [
      "Request payloads are derived from response schemas via ucp_request annotations (resolveUcpSchema).",
      "Capability negotiation uses the exact-version intersection algorithm from the overview specification.",
    ],
  },
  {
    protocol: "ACP",
    role: "Merchant B checkout (Agentic Checkout REST API)",
    version: ACP_API_VERSION,
    specification_url: "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/tree/main/spec/2026-01-16",
    source_repository: "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol",
    immutable_revision: "spec/2026-01-16 directory of the main branch (dated release directories are immutable)",
    vendored_files: [ACP_SCHEMA_PATH, ACP_OPENAPI_PATH, ACP_EXAMPLES_PATH],
    operations: [
      "POST /checkout_sessions",
      "GET /checkout_sessions/{id}",
      "POST /checkout_sessions/{id}",
      "POST /checkout_sessions/{id}/complete",
      "POST /checkout_sessions/{id}/cancel",
    ],
    notes: [
      "The 2026-04-17 release was evaluated and not selected: its CheckoutSessionCreateRequest.line_items uses an Item schema without a quantity member (additionalProperties: false), so a 10-unit purchase cannot be expressed in a schema-valid request. See docs/protocol-versions.md.",
      "Idempotency-Key required on every POST; API-Version header pinned to 2026-01-16.",
    ],
  },
];

export function specManifestWithDigests(): Array<SpecEntry & { digests: Record<string, string> }> {
  return SPEC_MANIFEST.map((entry) => ({
    ...entry,
    digests: Object.fromEntries(entry.vendored_files.map((f) => [f, sha256OfVendoredFile(f)])),
  }));
}
