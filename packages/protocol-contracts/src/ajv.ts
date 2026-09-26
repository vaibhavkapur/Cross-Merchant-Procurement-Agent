import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv-formats ships a CJS module whose default export is the plugin function;
// under NodeNext typings it surfaces as a namespace, so normalise it here.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv2020) => Ajv2020;

export type JsonSchema = Record<string, unknown>;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    // Vendored protocol schemas use vocabulary (e.g. UCP `ucp_request`) that is
    // not part of JSON Schema. We tolerate unknown keywords instead of editing
    // the pinned upstream files.
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
    validateFormats: true,
  });
  addFormats(ajv);
  return ajv;
}

export function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  return errors.map((e) => {
    const path = e.instancePath || "$";
    const extra =
      e.keyword === "additionalProperties"
        ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})`
        : e.keyword === "enum"
          ? ` (allowed: ${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)})`
          : "";
    return `${path} ${e.message ?? "invalid"}${extra}`;
  });
}

export function runValidator(fn: ValidateFunction, payload: unknown): ValidationResult {
  const ok = fn(payload) as boolean;
  return { ok, errors: ok ? [] : formatErrors(fn.errors) };
}

export class SchemaValidationError extends Error {
  readonly errors: string[];
  readonly schemaName: string;
  constructor(schemaName: string, errors: string[]) {
    super(`${schemaName} failed schema validation: ${errors.slice(0, 5).join("; ")}`);
    this.name = "SchemaValidationError";
    this.schemaName = schemaName;
    this.errors = errors;
  }
}

export function assertValid(name: string, result: ValidationResult): void {
  if (!result.ok) throw new SchemaValidationError(name, result.errors);
}
