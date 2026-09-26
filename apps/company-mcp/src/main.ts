import { createLogger } from "@procurement/audit";
import { buildCompanyMcp } from "./server.ts";

const port = Number(process.env.PORT ?? 4010);
const host = process.env.HOST ?? "0.0.0.0";
const logger = createLogger({ svc: "company-mcp" });
const app = buildCompanyMcp({ logger });
app.listen(port, host, () => {
  logger.info("listening", { address: `http://${host}:${port}`, transport: "mcp-streamable-http" });
});
