/**
 * Monetary amounts are integers in minor units (cents for USD) with an explicit
 * currency. Arithmetic is exact integer arithmetic guarded against overflow of
 * the JavaScript safe-integer range. Decimal strings are used when amounts cross
 * JSON boundaries in the application API (see `parseMinor` / `minorToString`).
 */

export type Minor = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertMinor(value: unknown, label = "amount"): Minor {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer in minor units, got ${String(value)}`);
  }
  return value;
}

export function assertNonNegativeMinor(value: unknown, label = "amount"): Minor {
  const v = assertMinor(value, label);
  if (v < 0) throw new MoneyError(`${label} must not be negative`);
  return v;
}

export function parseMinor(value: unknown, label = "amount"): Minor {
  if (typeof value === "number") return assertMinor(value, label);
  if (typeof value === "string" && /^-?\d{1,16}$/.test(value.trim())) {
    return assertMinor(Number(value.trim()), label);
  }
  throw new MoneyError(`${label} must be an integer or decimal string of minor units`);
}

export function minorToString(value: Minor): string {
  return String(assertMinor(value));
}

export function addMinor(...values: Minor[]): Minor {
  let sum = 0;
  for (const v of values) {
    sum += assertMinor(v);
    if (!Number.isSafeInteger(sum)) throw new MoneyError("sum overflows safe integer range");
  }
  return sum;
}

export function subMinor(a: Minor, b: Minor): Minor {
  const r = assertMinor(a) - assertMinor(b);
  if (!Number.isSafeInteger(r)) throw new MoneyError("difference overflows safe integer range");
  return r;
}

export function mulMinor(unit: Minor, quantity: number): Minor {
  assertMinor(unit, "unit price");
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new MoneyError("quantity must be a non-negative integer");
  const r = unit * quantity;
  if (!Number.isSafeInteger(r)) throw new MoneyError("product overflows safe integer range");
  return r;
}

export function assertCurrency(code: unknown): string {
  if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) throw new MoneyError(`invalid currency code: ${String(code)}`);
  return code;
}

export function sameCurrency(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** Human display (USD assumed to have 2 minor digits; extend per currency as needed). */
export function formatMinor(value: Minor, currency: string): string {
  const digits = currency.toUpperCase() === "JPY" ? 0 : 2;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const major = Math.floor(abs / 10 ** digits);
  const minor = String(abs % 10 ** digits).padStart(digits, "0");
  return `${sign}${major.toLocaleString("en-US")}${digits ? "." + minor : ""} ${currency.toUpperCase()}`;
}
