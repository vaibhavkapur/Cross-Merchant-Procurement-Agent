/**
 * Application contracts exchanged with supplier agents over A2A.
 *
 * A2A provides the task/message/artifact framework; the payloads below are the
 * request-for-quotation schema owned by this application (not an A2A or
 * protocol-level object). Supplier output is untrusted input: it is validated
 * here at the boundary and again by business rules in the comparison engine.
 */
import type { ValidateFunction } from "ajv/dist/2020.js";
import { createAjv, runValidator, type JsonSchema, type ValidationResult } from "./ajv.ts";

export const RFQ_CONTRACT = "procurement.rfq.v1" as const;
export const QUOTE_CONTRACT = "procurement.quote.v1" as const;
export const A2A_RFQ_MEDIA_TYPE = "application/vnd.procurement.rfq.v1+json";
export const A2A_QUOTE_MEDIA_TYPE = "application/vnd.procurement.quote.v1+json";

export interface RfqDestination {
  destination_id: string;
  country: string;
  region: string;
  locality: string;
  postal_code: string;
}

export interface RfqProduct {
  category: string;
  minimum_size_inches?: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface RfqRequest {
  contract: typeof RFQ_CONTRACT;
  rfq_id: string;
  product: RfqProduct;
  quantity: number;
  currency: string;
  destination: RfqDestination;
  required_delivery_by: string;
  response_deadline: string;
}

export type MerchantProtocol = "ucp" | "acp";

export interface QuoteMerchantRef {
  merchant_id: string;
  protocol: MerchantProtocol;
  protocol_version: string;
  endpoint: string;
}

export interface QuoteItem {
  merchant_item_id: string;
  sku: string;
  title: string;
  quantity: number;
  unit_price_minor: number;
  attributes: Record<string, string | number | boolean>;
}

export interface QuotePrice {
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  shipping_minor: number;
  total_minor: number;
}

export interface QuoteDelivery {
  method: string;
  /** RFC 3339 timestamp, or null when the supplier cannot promise a date. */
  promised_by: string | null;
}

export interface QuoteTerms {
  payment_terms: string;
  return_window_days: number;
}

export interface QuoteArtifact {
  contract: typeof QUOTE_CONTRACT;
  rfq_id: string;
  supplier_id: string;
  native_quote_id: string;
  merchant: QuoteMerchantRef;
  items: QuoteItem[];
  quantity_available: number;
  price: QuotePrice;
  delivery: QuoteDelivery;
  expires_at: string;
  terms: QuoteTerms;
  notes?: string;
}

const minorUnits: JsonSchema = { type: "integer", minimum: 0, maximum: 9007199254740991 };

export const rfqRequestSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:procurement:rfq:v1",
  type: "object",
  additionalProperties: false,
  required: ["contract", "rfq_id", "product", "quantity", "currency", "destination", "required_delivery_by", "response_deadline"],
  properties: {
    contract: { const: RFQ_CONTRACT },
    rfq_id: { type: "string", minLength: 1 },
    product: {
      type: "object",
      additionalProperties: false,
      required: ["category"],
      properties: {
        category: { type: "string", minLength: 1 },
        minimum_size_inches: { type: "number", exclusiveMinimum: 0 },
        attributes: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
      },
    },
    quantity: { type: "integer", minimum: 1 },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    destination: {
      type: "object",
      additionalProperties: false,
      required: ["destination_id", "country", "region", "locality", "postal_code"],
      properties: {
        destination_id: { type: "string" },
        country: { type: "string", pattern: "^[A-Z]{2}$" },
        region: { type: "string" },
        locality: { type: "string" },
        postal_code: { type: "string" },
      },
    },
    required_delivery_by: { type: "string", format: "date-time" },
    response_deadline: { type: "string", format: "date-time" },
  },
};

export const quoteArtifactSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:procurement:quote:v1",
  type: "object",
  additionalProperties: false,
  required: [
    "contract",
    "rfq_id",
    "supplier_id",
    "native_quote_id",
    "merchant",
    "items",
    "quantity_available",
    "price",
    "delivery",
    "expires_at",
    "terms",
  ],
  properties: {
    contract: { const: QUOTE_CONTRACT },
    rfq_id: { type: "string", minLength: 1 },
    supplier_id: { type: "string", minLength: 1 },
    native_quote_id: { type: "string", minLength: 1 },
    merchant: {
      type: "object",
      additionalProperties: false,
      required: ["merchant_id", "protocol", "protocol_version", "endpoint"],
      properties: {
        merchant_id: { type: "string", minLength: 1 },
        protocol: { enum: ["ucp", "acp"] },
        protocol_version: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        endpoint: { type: "string", format: "uri" },
      },
    },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["merchant_item_id", "sku", "title", "quantity", "unit_price_minor", "attributes"],
        properties: {
          merchant_item_id: { type: "string", minLength: 1 },
          sku: { type: "string" },
          title: { type: "string", maxLength: 200 },
          quantity: { type: "integer", minimum: 1 },
          unit_price_minor: minorUnits,
          attributes: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
        },
      },
    },
    quantity_available: { type: "integer", minimum: 0 },
    price: {
      type: "object",
      additionalProperties: false,
      required: ["currency", "subtotal_minor", "tax_minor", "shipping_minor", "total_minor"],
      properties: {
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
        subtotal_minor: minorUnits,
        tax_minor: minorUnits,
        shipping_minor: minorUnits,
        total_minor: minorUnits,
      },
    },
    delivery: {
      type: "object",
      additionalProperties: false,
      required: ["method", "promised_by"],
      properties: {
        method: { type: "string" },
        promised_by: { type: ["string", "null"], format: "date-time" },
      },
    },
    expires_at: { type: "string", format: "date-time" },
    terms: {
      type: "object",
      additionalProperties: false,
      required: ["payment_terms", "return_window_days"],
      properties: {
        payment_terms: { type: "string" },
        return_window_days: { type: "integer", minimum: 0 },
      },
    },
    notes: { type: "string", maxLength: 2000 },
  },
};

const ajv = createAjv();
const rfqValidator: ValidateFunction = ajv.compile(rfqRequestSchema);
const quoteValidator: ValidateFunction = ajv.compile(quoteArtifactSchema);

export function validateRfqRequest(payload: unknown): ValidationResult {
  return runValidator(rfqValidator, payload);
}

export function validateQuoteArtifact(payload: unknown): ValidationResult {
  return runValidator(quoteValidator, payload);
}
