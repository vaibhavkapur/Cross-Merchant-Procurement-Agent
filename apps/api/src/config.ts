import {
  loadCompany,
  loadMerchants,
  loadScenarios,
  loadSuppliers,
  merchantApiKey,
  withUrlOverrides,
  type CompanyFixture,
  type MerchantFixture,
  type SupplierFixture,
} from "@procurement/domain";

export interface ServiceConfig {
  host: string;
  port: number;
  publicUrl: string;
  companyMcpUrl: string;
  platformProfileUrl: string;
  paymentCredentialRef: string;
  company: CompanyFixture;
  merchants: MerchantFixture[];
  suppliers: SupplierFixture[];
  scenarios: ReturnType<typeof loadScenarios>;
}

export function loadConfig(): ServiceConfig {
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? 4000);
  const publicUrl = (process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const company = loadCompany();
  return {
    host,
    port,
    publicUrl,
    companyMcpUrl: process.env.COMPANY_MCP_URL ?? "http://127.0.0.1:4010/mcp",
    platformProfileUrl: process.env.PLATFORM_UCP_PROFILE_URL ?? `${publicUrl}/.well-known/ucp`,
    paymentCredentialRef: process.env.PAYMENT_CREDENTIAL_REF ?? company.payment_credential_ref,
    company,
    merchants: withUrlOverrides(loadMerchants(), "base_url", "MERCHANT"),
    suppliers: withUrlOverrides(loadSuppliers(), "agent_url", "SUPPLIER"),
    scenarios: loadScenarios(),
  };
}

export function apiKeyFor(merchant: { api_key_env: string; id: string }): string {
  const match = loadMerchants().find((m) => m.id === merchant.id);
  return match ? merchantApiKey(match) : process.env[merchant.api_key_env] ?? "";
}
