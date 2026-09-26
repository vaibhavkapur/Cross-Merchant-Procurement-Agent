/**
 * Deterministic intent extractor. A production deployment would call an LLM
 * with structured outputs; tests and the demo stay reproducible without one.
 *
 * Relative phrases such as "Friday" are resolved to an explicit RFC 3339
 * timestamp in the destination time zone before anything is approved.
 */
import { parseMinor, type CompanyFixture, type Destination, type IntentDraft, type SimulationFlags } from "@procurement/domain";

export interface ExtractInput {
  text?: string | null;
  structured?: {
    cost_center_id?: string;
    product?: { category?: string; minimum_size_inches?: number; attributes?: Record<string, string | number | boolean> };
    quantity?: number;
    currency?: string;
    budget_minor?: string | number;
    delivery_deadline?: string;
    destination_id?: string;
    allowed_merchants?: string[];
  };
  now?: Date;
  company: CompanyFixture;
  timezone?: string;
}

const COST_CENTER_ALIASES: Record<string, string> = {
  engineering: "cc_it_hardware",
  it: "cc_it_hardware",
  "it hardware": "cc_it_hardware",
  hardware: "cc_it_hardware",
  office: "cc_office",
  "office supplies": "cc_office",
};

const DESTINATION_ALIASES: Record<string, string> = {
  office_1: "dest_hq",
  hq: "dest_hq",
  "head office": "dest_hq",
  office: "dest_hq",
};

const WEEKDAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

export function extractIntent(input: ExtractInput): IntentDraft {
  const now = input.now ?? new Date();
  const dest = resolveDestination(input, input.company);
  const timezone = input.timezone ?? dest?.timezone ?? "America/Chicago";
  const text = (input.text ?? "").toLowerCase();
  const s = input.structured ?? {};
  const clarifications: string[] = [];

  const category = s.product?.category ?? (/\bmonitor/.test(text) ? "monitor" : /\bkeyboard/.test(text) ? "keyboard" : /\blaptop/.test(text) ? "laptop" : "");
  const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:inch|"|in\b)/);
  const minimum_size_inches = s.product?.minimum_size_inches ?? (sizeMatch ? Number(sizeMatch[1]) : undefined);
  const qtyMatch = text.match(/\b(\d+)\s+(?:monitor|keyboard|laptop|unit|item)/) ?? text.match(/\bbuy\s+(\d+)\b/);
  const quantity = s.quantity ?? (qtyMatch ? Number(qtyMatch[1]) : null);
  const budget = s.budget_minor !== undefined ? parseMinor(s.budget_minor, "budget_minor") : parseBudget(text);
  const cost_center_id = resolveCostCenter(s.cost_center_id ?? inferCostCenter(text), input.company);
  const destination_id = s.destination_id ? (DESTINATION_ALIASES[s.destination_id] ?? s.destination_id) : dest?.destination_id ?? null;
  const deadlinePhrase = inferDeadlinePhrase(text, s.delivery_deadline);
  const delivery_deadline = s.delivery_deadline ?? (deadlinePhrase ? resolveDeadline(deadlinePhrase, now, timezone) : null);

  if (!category) clarifications.push("Which product category should we buy?");
  if (quantity === null) clarifications.push("How many units do you need?");
  if (budget === null) clarifications.push("What is the maximum delivered budget in USD?");
  if (!delivery_deadline) clarifications.push("What is the delivery deadline (a date, 'Friday', or 'within N weeks')?");
  if (!destination_id) clarifications.push("Which destination should we ship to?");
  if (!cost_center_id) clarifications.push("Which cost centre should we charge?");

  return {
    product: { category, ...(minimum_size_inches !== undefined ? { minimum_size_inches } : {}), ...(s.product?.attributes ? { attributes: s.product.attributes } : {}) },
    quantity,
    budget_minor: budget,
    currency: s.currency ?? "USD",
    delivery_deadline,
    deadline_phrase: deadlinePhrase,
    destination_id,
    cost_center_id,
    allowed_merchants: s.allowed_merchants ?? null,
    clarifications,
    extractor: "deterministic-v1",
  };
}

export function applySimulation(scenarioId: string | undefined, explicit: SimulationFlags | undefined, scenarios: Record<string, { simulation: SimulationFlags }>): SimulationFlags {
  if (explicit && Object.keys(explicit).length) return explicit;
  if (scenarioId && scenarios[scenarioId]) return scenarios[scenarioId].simulation;
  return {};
}

function parseBudget(text: string): number | null {
  const m = text.match(/\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)/) ?? text.match(/\b([0-9][0-9,]*)\s*(?:usd|dollars)\b/);
  if (!m?.[1]) return null;
  const dollars = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

function inferCostCenter(text: string): string | null {
  if (/it hardware|engineering|hardware/.test(text)) return "cc_it_hardware";
  if (/office/.test(text)) return "cc_office";
  return null;
}

function resolveCostCenter(id: string | null | undefined, company: CompanyFixture): string | null {
  if (!id) return null;
  const aliased = COST_CENTER_ALIASES[id.toLowerCase()] ?? id;
  return company.cost_centers.some((c) => c.id === aliased) ? aliased : aliased;
}

function resolveDestination(input: ExtractInput, company: CompanyFixture): Destination | undefined {
  if (input.structured?.destination_id) {
    const id = DESTINATION_ALIASES[input.structured.destination_id] ?? input.structured.destination_id;
    return company.destinations.find((d) => d.destination_id === id);
  }
  const text = (input.text ?? "").toLowerCase();
  if (/hq|head office|office/.test(text) || !text) return company.destinations[0];
  return company.destinations[0];
}

function inferDeadlinePhrase(text: string, explicit?: string): string | null {
  if (explicit) return explicit;
  const weeks = text.match(/within\s+(\d+)\s+weeks?/);
  if (weeks?.[1]) return `within_${weeks[1]}_weeks`;
  const days = text.match(/within\s+(\d+)\s+days?/);
  if (days?.[1]) return `within_${days[1]}_days`;
  const day = Object.keys(WEEKDAYS).find((d) => new RegExp(`\\b${d}\\b`).test(text));
  if (day) return day;
  return null;
}

/** Next occurrence of a weekday (or a relative window) at 17:00 in `timeZone`. */
export function resolveDeadline(phrase: string, now: Date, timeZone: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(phrase)) return phrase;
  const weeks = /^within_(\d+)_weeks$/.exec(phrase);
  if (weeks) return atLocalHour(addDays(now, Number(weeks[1]) * 7), timeZone, 17, 0);
  const days = /^within_(\d+)_days$/.exec(phrase);
  if (days) return atLocalHour(addDays(now, Number(days[1])), timeZone, 17, 0);
  const weekday = WEEKDAYS[phrase.toLowerCase()];
  if (weekday === undefined) return null;
  return atLocalHour(nextWeekday(now, weekday, timeZone), timeZone, 17, 0);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function tzParts(date: Date, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday: weekdayMap[parts.weekday ?? "Sun"] ?? 0 };
}

function nextWeekday(now: Date, weekday: number, timeZone: string): Date {
  const parts = tzParts(now, timeZone);
  let delta = (weekday - parts.weekday + 7) % 7;
  if (delta === 0) delta = 7; // "before Friday" on Friday means next Friday
  return addDays(now, delta);
}

function atLocalHour(date: Date, timeZone: string, hour: number, minute: number): string {
  const parts = tzParts(date, timeZone);
  const isoDate = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const probe = new Date(`${isoDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const offsetMs = localOffsetMs(probe, timeZone);
  const utc = new Date(probe.getTime() - offsetMs);
  return utc.toISOString();
}

function localOffsetMs(utcGuess: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(utcGuess).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - utcGuess.getTime();
}
