import { createLogger } from "@procurement/audit";
import { loadSuppliers } from "@procurement/domain";
import { buildSupplierAgent } from "./server.ts";

const supplier = loadSuppliers().find((s) => s.id === "supplier_b")!;
const port = Number(process.env.PORT ?? 4022);
const host = process.env.HOST ?? "0.0.0.0";
const baseUrl = process.env.PUBLIC_URL ?? supplier.agent_url;
const logger = createLogger({ svc: "supplier-b" });
const app = buildSupplierAgent({ supplierId: "supplier_b", supplier, baseUrl });
app.listen(port, host, () => {
  logger.info("listening", { address: `http://${host}:${port}`, agent_url: baseUrl });
});
