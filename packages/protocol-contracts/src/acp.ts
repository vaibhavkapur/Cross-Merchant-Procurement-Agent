/**
 * Agentic Commerce Protocol (OpenAI/Stripe) — Agentic Checkout, release 2026-01-16.
 *
 * Types below mirror the vendored JSON Schema bundle
 * `vendor/acp/2026-01-16/json-schema/schema.agentic_checkout.json`. The bundle
 * itself is the source of truth; every native message crossing the adapter
 * boundary is validated against it.
 */
import type { ValidateFunction } from "ajv/dist/2020.js";
import { createAjv, runValidator, type JsonSchema, type ValidationResult } from "./ajv.ts";
import { readVendoredJson } from "./vendor.ts";

export const ACP_API_VERSION = "2026-01-16" as const;
export const ACP_SCHEMA_PATH = "acp/2026-01-16/json-schema/schema.agentic_checkout.json";
export const ACP_OPENAPI_PATH = "acp/2026-01-16/openapi/openapi.agentic_checkout.yaml";
export const ACP_EXAMPLES_PATH = "acp/2026-01-16/examples/examples.agentic_checkout.json";

// ---------------------------------------------------------------------------
// Native types (2026-01-16)
// ---------------------------------------------------------------------------

export interface AcpAddress {
  name: string;
  line_one: string;
  line_two?: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
}

export interface AcpBuyer {
  first_name: string;
  last_name: string;
  email: string;
  phone_number?: string;
}

export interface AcpItem {
  id: string;
  quantity: number;
}

export interface AcpFulfillmentDetails {
  name?: string;
  phone_number?: string;
  email?: string;
  address?: AcpAddress;
}

export interface AcpTotal {
  type: "items_base_amount" | "items_discount" | "subtotal" | "discount" | "fulfillment" | "tax" | "fee" | "total";
  display_text: string;
  amount: number;
  description?: string;
}

export interface AcpLineItem {
  id: string;
  item: AcpItem;
  base_amount: number;
  discount: number;
  subtotal: number;
  tax: number;
  total: number;
  name?: string;
  description?: string;
  images?: string[];
  unit_amount?: number;
}

export interface AcpFulfillmentOptionShipping {
  type: "shipping";
  id: string;
  title: string;
  description?: string;
  carrier?: string;
  earliest_delivery_time?: string;
  latest_delivery_time?: string;
  totals: AcpTotal[];
}

export interface AcpFulfillmentOptionDigital {
  type: "digital";
  id: string;
  title: string;
  description?: string;
  totals: AcpTotal[];
}

export type AcpFulfillmentOption = AcpFulfillmentOptionShipping | AcpFulfillmentOptionDigital;

export interface AcpSelectedFulfillmentOption {
  type: "shipping" | "digital";
  shipping?: { option_id: string; item_ids: string[] };
  digital?: { option_id: string; item_ids: string[] };
}

export interface AcpMessageInfo {
  type: "info";
  param?: string;
  content_type: "plain" | "markdown";
  content: string;
}

export type AcpMessageErrorCode =
  | "missing"
  | "invalid"
  | "out_of_stock"
  | "payment_declined"
  | "requires_sign_in"
  | "requires_3ds";

export interface AcpMessageError {
  type: "error";
  code: AcpMessageErrorCode;
  param?: string;
  content_type: "plain" | "markdown";
  content: string;
}

export type AcpMessage = AcpMessageInfo | AcpMessageError;

export interface AcpLink {
  type: "terms_of_use" | "privacy_policy" | "return_policy";
  url: string;
}

export interface AcpPaymentMethod {
  type: "card";
  supported_card_networks: string[];
}

export interface AcpPaymentProvider {
  provider: "stripe";
  merchant_id: string;
  supported_payment_methods: AcpPaymentMethod[];
}

export interface AcpOrder {
  id: string;
  checkout_session_id: string;
  permalink_url: string;
}

export type AcpSessionStatus =
  | "not_ready_for_payment"
  | "ready_for_payment"
  | "completed"
  | "canceled"
  | "in_progress"
  | "authentication_required";

export interface AcpCheckoutSession {
  id: string;
  buyer?: AcpBuyer;
  payment_provider?: AcpPaymentProvider;
  status: AcpSessionStatus;
  currency: string;
  line_items: AcpLineItem[];
  fulfillment_details?: AcpFulfillmentDetails;
  fulfillment_options: AcpFulfillmentOption[];
  selected_fulfillment_options?: AcpSelectedFulfillmentOption[];
  totals: AcpTotal[];
  messages: AcpMessage[];
  links: AcpLink[];
  order?: AcpOrder;
}

export interface AcpCheckoutSessionWithOrder extends AcpCheckoutSession {
  order: AcpOrder;
}

export interface AcpCheckoutSessionCreateRequest {
  buyer?: AcpBuyer;
  items: AcpItem[];
  fulfillment_details?: AcpFulfillmentDetails;
}

export interface AcpCheckoutSessionUpdateRequest {
  buyer?: AcpBuyer;
  items?: AcpItem[];
  fulfillment_details?: AcpFulfillmentDetails;
  selected_fulfillment_options?: AcpSelectedFulfillmentOption[];
}

export interface AcpPaymentData {
  token: string;
  provider: "stripe";
  billing_address?: AcpAddress;
}

export interface AcpCheckoutSessionCompleteRequest {
  buyer?: AcpBuyer;
  payment_data: AcpPaymentData;
}

export interface AcpError {
  type: "invalid_request" | "request_not_idempotent" | "processing_error" | "service_unavailable";
  code: string;
  message: string;
  param?: string;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export type AcpDefinition =
  | "CheckoutSession"
  | "CheckoutSessionWithOrder"
  | "CheckoutSessionCreateRequest"
  | "CheckoutSessionUpdateRequest"
  | "CheckoutSessionCompleteRequest"
  | "CancelSessionRequest"
  | "Error";

const bundle = readVendoredJson<JsonSchema & { $id: string }>(ACP_SCHEMA_PATH);
const ajv = createAjv();
ajv.addSchema(bundle);
const cache = new Map<AcpDefinition, ValidateFunction>();

function validatorFor(def: AcpDefinition): ValidateFunction {
  let fn = cache.get(def);
  if (!fn) {
    fn = ajv.compile({ $ref: `${bundle.$id}#/$defs/${def}` });
    cache.set(def, fn);
  }
  return fn;
}

export function validateAcp(def: AcpDefinition, payload: unknown): ValidationResult {
  return runValidator(validatorFor(def), payload);
}

export function acpExamples(): Record<string, unknown> {
  return readVendoredJson<Record<string, unknown>>(ACP_EXAMPLES_PATH);
}

/** Convenience: read the "total" line from a session's totals. */
export function acpTotalAmount(session: AcpCheckoutSession, type: AcpTotal["type"]): number | undefined {
  return session.totals.find((t) => t.type === type)?.amount;
}
