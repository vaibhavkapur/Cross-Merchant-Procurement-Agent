import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Principal, PurchasingPolicy } from "@procurement/policy";
import { ACP_API_VERSION, QUOTE_CONTRACT, UCP_VERSION, type QuoteArtifact, type RfqRequest } from "@procurement/protocol-contracts";
import type { CostCenter, Destination, Merchant, SimulationFlags, Supplier } from "./types.ts";
import type { SqlDriver } from "./db/driver.ts";
import { addMinor, mulMinor } from "./money.ts";
import { Store } from "./store.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..", "..", "..");
export const FIXTURES_DIR = process.env.FIXTURES_DIR ?? join(REPO_ROOT, "fixtures");

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as T;
}

export interface FixturePrincipal extends Principal {
  email: string;
  token: string;
}

export interface InventoryItem {
  sku: string;
  category: string;
  description: string;
  size_inches?: number;
  on_hand: number;
  reserved: number;
  location: string;
}

export interface CompanyFixture {
  organization: { id: string; name: string };
  principals: FixturePrincipal[];
  cost_centers: CostCenter[];
  destinations: Destination[];
  inventory: InventoryItem[];
  policy: PurchasingPolicy;
  payment_credential_ref: string;
}

export interface CatalogItem {
  item_id: string;
  sku: string;
  title: string;
  category: string;
  size_inches?: number;
  unit_price_minor: number;
  stock: number;
}

export interface FulfillmentOptionFixture {
  option_id: string;
  title: string;
  price_minor: number;
  lead_days: number;
}

export interface MerchantFixture extends Merchant {
  api_key_default: string;
  catalog: CatalogItem[];
  fulfillment_options: FulfillmentOptionFixture[];
  tax_rate_bps: number;
  payment_handler?: { id: string; name: string; version: string };
  payment_provider?: string;
}

export interface SupplierFixture extends Supplier {
  default_fulfillment_option: string;
  quote_validity_minutes: number;
  payment_terms: string;
  return_window_days: number;
}

export interface Scenario {
  title: string;
  text: string;
  expect: string;
  simulation: SimulationFlags;
}

export function loadCompany(): CompanyFixture {
  return readJson<CompanyFixture>("company.json");
}

export function loadMerchants(): MerchantFixture[] {
  return readJson<{ merchants: MerchantFixture[] }>("merchants.json").merchants;
}

export function loadSuppliers(): SupplierFixture[] {
  return readJson<{ suppliers: SupplierFixture[] }>("suppliers.json").suppliers;
}

export function loadScenarios(): Record<string, Scenario> {
  return readJson<{ scenarios: Record<string, Scenario> }>("scenarios.json").scenarios;
}

export function merchantApiKey(m: MerchantFixture): string {
  return process.env[m.api_key_env] ?? m.api_key_default;
}

/** Allow env overrides of fixture URLs (docker-compose uses service hostnames). */
export function withUrlOverrides<T extends { id: string }>(items: T[], field: keyof T & string, envPrefix: string): T[] {
  return items.map((item) => {
    const env = process.env[`${envPrefix}_${item.id.toUpperCase()}_URL`];
    if (!env) return item;
    const copy = { ...item } as Record<string, unknown>;
    copy[field] = env;
    if (field === "base_url" && typeof copy["discovery_url"] === "string") {
      copy["discovery_url"] = String(copy["discovery_url"]).replace(String(item[field]), env);
    }
    return copy as T;
  });
}

export function protocolOf(m: Merchant): Merchant["protocol"] {
  return m.protocol;
}

/** Insert the fixture organization, buyers, and cost centres (idempotent). */
export async function seedDatabase(driver: SqlDriver, company = loadCompany()): Promise<CompanyFixture> {
  const store = new Store(driver);
  await store.upsertOrganization(company.organization.id, company.organization.name);
  for (const p of company.principals) {
    await store.upsertBuyer({ id: p.id, organization_id: p.organization_id, name: p.name, email: p.email, can_purchase: p.can_purchase });
  }
  for (const cc of company.cost_centers) {
    await store.upsertCostCenter(cc);
  }
  return company;
}

/**
 * Deterministic quote from a merchant catalog. Used by the A2A supplier
 * agents and by unit tests that need a schema-valid `procurement.quote.v1`.
 */
export function buildFixtureQuote(input: { rfq: RfqRequest; supplier: SupplierFixture; merchant: MerchantFixture; now: Date; notes?: string }): QuoteArtifact {
  const { rfq, supplier, merchant, now } = input;
  const item = pickCatalogItem(merchant, rfq.product.category, rfq.product.minimum_size_inches);
  if (!item) {
    throw new Error(`merchant ${merchant.id} has no catalog item in category ${rfq.product.category}`);
  }
  const option = merchant.fulfillment_options.find((o) => o.option_id === supplier.default_fulfillment_option) ?? merchant.fulfillment_options[0];
  if (!option) throw new Error(`merchant ${merchant.id} has no fulfillment options`);
  const subtotal = mulMinor(item.unit_price_minor, rfq.quantity);
  const tax = Math.round((subtotal * merchant.tax_rate_bps) / 10_000);
  const shipping = option.price_minor;
  const total = addMinor(subtotal, tax, shipping);
  const promised = new Date(now.getTime() + option.lead_days * 86_400_000);
  const expires = new Date(now.getTime() + supplier.quote_validity_minutes * 60_000);
  const protocolVersion = merchant.protocol === "ucp" ? UCP_VERSION : ACP_API_VERSION;
  return {
    contract: QUOTE_CONTRACT,
    rfq_id: rfq.rfq_id,
    supplier_id: supplier.id,
    native_quote_id: `nq_${supplier.id}_${rfq.rfq_id}`,
    merchant: {
      merchant_id: merchant.id,
      protocol: merchant.protocol,
      protocol_version: protocolVersion,
      endpoint: merchant.base_url,
    },
    items: [
      {
        merchant_item_id: item.item_id,
        sku: item.sku,
        title: item.title,
        quantity: rfq.quantity,
        unit_price_minor: item.unit_price_minor,
        attributes: {
          category: item.category,
          ...(item.size_inches !== undefined ? { size_inches: item.size_inches } : {}),
        },
      },
    ],
    quantity_available: item.stock,
    price: { currency: rfq.currency, subtotal_minor: subtotal, tax_minor: tax, shipping_minor: shipping, total_minor: total },
    delivery: { method: option.option_id, promised_by: promised.toISOString() },
    expires_at: expires.toISOString(),
    terms: { payment_terms: supplier.payment_terms, return_window_days: supplier.return_window_days },
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

export function pickCatalogItem(merchant: MerchantFixture, category: string, minimumSizeInches?: number): CatalogItem | undefined {
  const inCategory = merchant.catalog.filter((c) => c.category.toLowerCase() === category.toLowerCase());
  if (minimumSizeInches !== undefined) {
    const sized = inCategory.filter((c) => c.size_inches !== undefined && c.size_inches >= minimumSizeInches);
    if (sized[0]) return sized[0];
  }
  return inCategory[0];
}
