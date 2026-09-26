/**
 * Universal Commerce Protocol — release v2026-08-25 (schemas vendored under
 * `vendor/ucp/v2026-08-25/schemas`).
 *
 * UCP publishes one schema per resource and derives request payload shapes
 * from response schemas through `ucp_request` / `ucp_response` annotations
 * ("omit" | "optional" | "required", optionally per operation). The upstream
 * project ships a Rust tool (`ucp-schema resolve`) to perform that derivation.
 * `resolveUcpSchema` below is a small TypeScript implementation of the same
 * contract so that both directions of every checkout message can be validated
 * against the pinned release without external tooling.
 */
import type { ValidateFunction } from "ajv/dist/2020.js";
import { createAjv, runValidator, type JsonSchema, type ValidationResult } from "./ajv.ts";
import { listVendoredFiles, readVendoredJson } from "./vendor.ts";

export const UCP_VERSION = "2026-08-25" as const;
export const UCP_SCHEMA_ROOT = "ucp/v2026-08-25/schemas";
export const UCP_REST_OPENAPI_PATH = "ucp/v2026-08-25/services/shopping/rest.openapi.json";
export const UCP_SCHEMA_BASE = "https://ucp.dev/schemas/";
export const UCP_CHECKOUT_CAPABILITY = "dev.ucp.shopping.checkout" as const;
export const UCP_FULFILLMENT_CAPABILITY = "dev.ucp.shopping.fulfillment" as const;
export const UCP_SHOPPING_SERVICE = "dev.ucp.shopping" as const;

export type UcpDirection = "request" | "response";
export type UcpOperation = "create" | "update" | "complete" | "cancel" | "read";

// ---------------------------------------------------------------------------
// Native types (subset used by this application)
// ---------------------------------------------------------------------------

export interface UcpEntity {
  version: string;
  spec?: string;
  schema?: string;
  id?: string;
  config?: Record<string, unknown>;
}

export interface UcpServiceBinding extends UcpEntity {
  transport: "rest" | "mcp" | "a2a" | "embedded";
  endpoint?: string;
}

export interface UcpCapabilityDecl extends UcpEntity {
  extends?: string | string[];
}

export interface UcpPaymentHandlerDecl extends UcpEntity {
  id: string;
  available_instruments?: Array<{ type: string; constraints?: Record<string, unknown> }>;
}

export interface UcpMetadata {
  version: string;
  status?: "success" | "error";
  supported_versions?: Record<string, string>;
  services?: Record<string, UcpServiceBinding[]>;
  capabilities?: Record<string, UcpCapabilityDecl[]>;
  payment_handlers?: Record<string, UcpPaymentHandlerDecl[]>;
}

export interface UcpBusinessProfile {
  ucp: UcpMetadata;
  keys?: unknown[];
}

export interface UcpTotal {
  type: string;
  display_text?: string;
  amount: number;
}

export interface UcpItem {
  id: string;
  title?: string;
  price?: number;
  image_url?: string;
}

export interface UcpLineItem {
  id?: string;
  item: UcpItem;
  quantity: number;
  totals?: UcpTotal[];
}

export interface UcpBuyer {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
}

export interface UcpPostalAddress {
  street_address?: string;
  extended_address?: string;
  address_locality?: string;
  address_region?: string;
  address_country?: string;
  postal_code?: string;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
}

export interface UcpShippingDestination extends UcpPostalAddress {
  id?: string;
  type?: "shipping_address";
}

export interface UcpFulfillmentOption {
  id: string;
  title: string;
  description?: { plain?: string; html?: string; markdown?: string };
  carrier?: string;
  earliest_fulfillment_time?: string;
  latest_fulfillment_time?: string;
  totals: UcpTotal[];
}

export interface UcpFulfillmentGroup {
  id: string;
  line_item_ids?: string[];
  options?: UcpFulfillmentOption[];
  selected_option_id?: string | null;
}

export interface UcpFulfillmentMethod {
  id?: string;
  type: "shipping" | "pickup" | string;
  line_item_ids?: string[];
  destinations?: UcpShippingDestination[];
  selected_destination_id?: string | null;
  groups?: UcpFulfillmentGroup[];
}

export interface UcpFulfillment {
  methods?: UcpFulfillmentMethod[];
  available_methods?: Array<{ type: string; line_item_ids: string[]; fulfillable_on?: string | null; description?: string }>;
}

export type UcpMessageSeverity = "recoverable" | "requires_buyer_input" | "requires_buyer_review" | "unrecoverable";

export interface UcpMessageError {
  type: "error";
  code: string;
  path?: string;
  content_type?: "plain" | "markdown";
  content: string;
  severity: UcpMessageSeverity;
}

export interface UcpMessageInfo {
  type: "info";
  code?: string;
  path?: string;
  content_type?: "plain" | "markdown";
  content: string;
}

export interface UcpMessageWarning {
  type: "warning";
  code: string;
  path?: string;
  content_type?: "plain" | "markdown";
  content: string;
}

export type UcpMessage = UcpMessageError | UcpMessageInfo | UcpMessageWarning;

export interface UcpLink {
  type: string;
  url: string;
}

export interface UcpPaymentInstrument {
  id: string;
  handler_id: string;
  type: string;
  selected?: boolean;
  billing_address?: UcpPostalAddress;
  credential?: { type: string; token?: string; [k: string]: unknown };
  display?: Record<string, unknown>;
}

export interface UcpPayment {
  instruments?: UcpPaymentInstrument[];
}

export interface UcpOrderConfirmation {
  id: string;
  label?: string;
  permalink_url: string;
}

export type UcpCheckoutStatus =
  | "incomplete"
  | "requires_escalation"
  | "ready_for_complete"
  | "complete_in_progress"
  | "completed"
  | "canceled";

export interface UcpCheckout {
  ucp: UcpMetadata;
  id: string;
  status: UcpCheckoutStatus;
  currency: string;
  line_items: UcpLineItem[];
  buyer?: UcpBuyer;
  totals: UcpTotal[];
  messages?: UcpMessage[];
  links: UcpLink[];
  expires_at?: string;
  continue_url?: string;
  payment?: UcpPayment;
  fulfillment?: UcpFulfillment;
  order?: UcpOrderConfirmation;
}

/** Request payload for create/update (derived: response-only fields omitted). */
export interface UcpCheckoutRequest {
  line_items: UcpLineItem[];
  buyer?: UcpBuyer;
  fulfillment?: UcpFulfillment;
  payment?: UcpPayment;
}

export interface UcpCompleteRequest {
  payment: UcpPayment;
  signals?: Record<string, unknown>;
}

export interface UcpErrorResponse {
  ucp: UcpMetadata & { status: "error" };
  messages: UcpMessage[];
  continue_url?: string;
}

// ---------------------------------------------------------------------------
// Schema store + UCP-aware resolver
// ---------------------------------------------------------------------------

type SchemaNode = Record<string, unknown>;

const schemaFiles = new Map<string, SchemaNode>(); // keyed by absolute $id
for (const rel of listVendoredFiles(UCP_SCHEMA_ROOT)) {
  const doc = readVendoredJson<SchemaNode>(rel);
  const id = typeof doc.$id === "string" ? doc.$id : UCP_SCHEMA_BASE + rel.slice(UCP_SCHEMA_ROOT.length + 1);
  schemaFiles.set(id, doc);
}

export function ucpSchemaId(relPath: string): string {
  return UCP_SCHEMA_BASE + relPath.replace(/^\/+/, "");
}

export function ucpSchemaIds(): string[] {
  return [...schemaFiles.keys()].sort();
}

function defsKey(id: string): string {
  return id.replace(UCP_SCHEMA_BASE, "").replace(/\.json$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

function applicability(annotation: unknown, op: UcpOperation): "omit" | "optional" | "required" | undefined {
  if (annotation === undefined) return undefined;
  if (typeof annotation === "string") return annotation as "omit" | "optional" | "required";
  if (annotation && typeof annotation === "object") {
    const v = (annotation as Record<string, unknown>)[op];
    // A per-operation map that does not mention this operation is treated as
    // "optional" — the member is neither forced nor forbidden for that op.
    return typeof v === "string" ? (v as "omit" | "optional" | "required") : "optional";
  }
  return undefined;
}

interface ResolveContext {
  direction: UcpDirection;
  op: UcpOperation;
  defs: Record<string, SchemaNode>;
  visiting: Set<string>;
}

const SCHEMA_CONTAINER_KEYS = new Set([
  "properties",
  "$defs",
  "definitions",
  "patternProperties",
  "dependentSchemas",
]);
const SCHEMA_LIST_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_SINGLE_KEYS = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "additionalItems",
]);
const NON_SCHEMA_KEYS = new Set(["enum", "const", "examples", "example", "default", "required"]);

function transformNode(node: unknown, baseId: string, ctx: ResolveContext): unknown {
  if (Array.isArray(node)) return node.map((n) => transformNode(n, baseId, ctx));
  if (!node || typeof node !== "object") return node;
  const src = node as SchemaNode;
  const out: SchemaNode = {};

  // Resolve $ref first so that sibling keywords are preserved alongside it.
  if (typeof src.$ref === "string") {
    out.$ref = rewriteRef(src.$ref, baseId, ctx);
  }

  const removed = new Set<string>();
  const force: string[] = [];
  const optional = new Set<string>();
  for (const [key, value] of Object.entries(src)) {
    if (key === "$ref" || key === "ucp_request" || key === "ucp_response") continue;
    if (key === "$id" || key === "$schema") continue;
    if (NON_SCHEMA_KEYS.has(key)) {
      out[key] = value;
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      const props: SchemaNode = {};
      for (const [pname, pschema] of Object.entries(value as SchemaNode)) {
        const ps = pschema as SchemaNode;
        if (ctx.direction === "request") {
          const a = applicability(ps.ucp_request, ctx.op);
          if (a === "omit") {
            removed.add(pname);
            continue;
          }
          if (a === "required") force.push(pname);
          if (a === "optional") optional.add(pname);
        } else if (applicability(ps.ucp_response, ctx.op) === "omit") {
          removed.add(pname);
          continue;
        }
        props[pname] = transformNode(ps, baseId, ctx);
      }
      out.properties = props;
      continue;
    }
    if (SCHEMA_CONTAINER_KEYS.has(key) && value && typeof value === "object") {
      const container: SchemaNode = {};
      for (const [k, v] of Object.entries(value as SchemaNode)) container[k] = transformNode(v, baseId, ctx);
      out[key] = container;
      continue;
    }
    if (SCHEMA_LIST_KEYS.has(key) || SCHEMA_SINGLE_KEYS.has(key)) {
      out[key] = transformNode(value, baseId, ctx);
      continue;
    }
    out[key] = value;
  }

  // Reconcile `required` with annotations.
  if (Array.isArray(out.required) || force.length || removed.size) {
    const req = new Set<string>((out.required as string[] | undefined) ?? []);
    for (const r of removed) req.delete(r);
    for (const o of optional) req.delete(o);
    for (const f of force) req.add(f);
    if (req.size) out.required = [...req];
    else delete out.required;
  }
  return out;
}

function rewriteRef(ref: string, baseId: string, ctx: ResolveContext): string {
  const [target, fragment = ""] = ref.split("#");
  const absolute = target ? new URL(target, baseId).toString() : baseId;
  ensureDef(absolute, ctx);
  const pointer = fragment ? fragment.replace(/^\//, "") : "";
  return pointer ? `#/$defs/${defsKey(absolute)}/${pointer}` : `#/$defs/${defsKey(absolute)}`;
}

function ensureDef(id: string, ctx: ResolveContext): void {
  const key = defsKey(id);
  if (ctx.defs[key] || ctx.visiting.has(id)) return;
  const doc = schemaFiles.get(id);
  if (!doc) throw new Error(`UCP schema not vendored: ${id}`);
  ctx.visiting.add(id);
  ctx.defs[key] = {}; // placeholder for cycles
  ctx.defs[key] = transformNode(doc, id, ctx) as SchemaNode;
  ctx.visiting.delete(id);
}

/**
 * Produce a self-contained JSON Schema (draft 2020-12) for one UCP schema file,
 * derived for the requested direction and operation. `rootRef` may point at a
 * definition inside the file, e.g. `shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout`.
 */
export function resolveUcpSchema(rootRef: string, direction: UcpDirection, op: UcpOperation): JsonSchema {
  const [file, fragment = ""] = rootRef.split("#");
  const id = file!.startsWith("http") ? file! : ucpSchemaId(file!);
  const ctx: ResolveContext = { direction, op, defs: {}, visiting: new Set() };
  ensureDef(id, ctx);
  const pointer = fragment.replace(/^\//, "");
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:ucp-derived:${UCP_VERSION}:${direction}:${op}:${defsKey(id)}${pointer ? ":" + pointer.replace(/[^a-zA-Z0-9]/g, "_") : ""}`,
    $ref: pointer ? `#/$defs/${defsKey(id)}/${pointer}` : `#/$defs/${defsKey(id)}`,
    $defs: ctx.defs,
  };
}

const ajv = createAjv();
const compiled = new Map<string, ValidateFunction>();

export function ucpValidator(rootRef: string, direction: UcpDirection, op: UcpOperation): ValidateFunction {
  const key = `${rootRef}|${direction}|${op}`;
  let fn = compiled.get(key);
  if (!fn) {
    fn = ajv.compile(resolveUcpSchema(rootRef, direction, op));
    compiled.set(key, fn);
  }
  return fn;
}

/** Checkout composed with the fulfillment extension (what a shipping merchant returns). */
export const UCP_CHECKOUT_WITH_FULFILLMENT_REF = "shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout";

export function validateUcpCheckoutResponse(payload: unknown): ValidationResult {
  return runValidator(ucpValidator(UCP_CHECKOUT_WITH_FULFILLMENT_REF, "response", "read"), payload);
}

export function validateUcpCheckoutRequest(op: "create" | "update" | "complete", payload: unknown): ValidationResult {
  return runValidator(ucpValidator(UCP_CHECKOUT_WITH_FULFILLMENT_REF, "request", op), payload);
}

export function validateUcpBusinessProfile(payload: unknown): ValidationResult {
  return runValidator(ucpValidator("profile.json#/$defs/business_schema", "response", "read"), payload);
}

export function validateUcpErrorResponse(payload: unknown): ValidationResult {
  return runValidator(ucpValidator("common/types/error_response.json", "response", "read"), payload);
}

export function isUcpErrorResponse(payload: unknown): payload is UcpErrorResponse {
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as { ucp?: { status?: string } }).ucp?.status === "error" &&
    !("id" in (payload as object))
  );
}

// ---------------------------------------------------------------------------
// Capability negotiation (overview §Negotiation Protocol — intersection algorithm)
// ---------------------------------------------------------------------------

export interface NegotiatedCapability {
  name: string;
  version: string;
  extends?: string | string[];
}

/** Exact-version intersection with orphaned-extension pruning, as specified by UCP. */
export function intersectCapabilities(
  platform: Record<string, UcpCapabilityDecl[]>,
  business: Record<string, UcpCapabilityDecl[]>,
): NegotiatedCapability[] {
  const result = new Map<string, NegotiatedCapability>();
  for (const [name, businessDecls] of Object.entries(business)) {
    const platformDecls = platform[name];
    if (!platformDecls) continue;
    const mutual = businessDecls
      .map((d) => d.version)
      .filter((v) => platformDecls.some((p) => p.version === v))
      .sort();
    const version = mutual.at(-1);
    if (!version) continue;
    const decl = businessDecls.find((d) => d.version === version)!;
    result.set(name, { name, version, ...(decl.extends ? { extends: decl.extends } : {}) });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, cap] of result) {
      if (!cap.extends) continue;
      const parents = Array.isArray(cap.extends) ? cap.extends : [cap.extends];
      if (!parents.some((p) => result.has(p))) {
        result.delete(name);
        changed = true;
      }
    }
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function ucpTotal(checkout: UcpCheckout, type: string): number | undefined {
  return checkout.totals.find((t) => t.type === type)?.amount;
}
