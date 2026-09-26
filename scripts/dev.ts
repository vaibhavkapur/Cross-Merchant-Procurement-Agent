/**
 * Start every local process for the demo: MCP, two suppliers, two merchants,
 * API, worker, and (optionally) the Next.js UI.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "@procurement/audit";

const logger = createLogger({ svc: "dev" });
const children: ChildProcess[] = [];

function run(name: string, args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string): ChildProcess {
  const child = spawn(process.execPath, args, { stdio: "inherit", cwd, env: { ...process.env, ...env } });
  child.on("exit", (code) => {
    if (code && code !== 0) logger.error("process_exited", { name, code });
  });
  children.push(child);
  return child;
}

const withWeb = !process.argv.includes("--no-web");

run("company-mcp", ["apps/company-mcp/src/main.ts"], { PORT: "4010" });
run("supplier-a", ["apps/supplier-a/src/main.ts"], { PORT: "4021" });
run("supplier-b", ["apps/supplier-b/src/main.ts"], { PORT: "4022" });
run("merchant-ucp", ["apps/merchant-ucp/src/main.ts"], { PORT: "4031" });
run("merchant-acp", ["apps/merchant-acp/src/main.ts"], { PORT: "4032" });
run("api", ["apps/api/src/main.ts"], { PORT: "4000" });
run("worker", ["apps/worker/src/main.ts"]);
if (withWeb) {
  run("web", ["../../node_modules/next/dist/bin/next", "dev", "--port", "3000"], { NEXT_PUBLIC_API_URL: "http://127.0.0.1:4000" }, "apps/web");
}

logger.info("stack_started", {
  api: "http://127.0.0.1:4000",
  web: withWeb ? "http://127.0.0.1:3000" : "disabled",
  mcp: "http://127.0.0.1:4010/mcp",
  supplier_a: "http://127.0.0.1:4021",
  supplier_b: "http://127.0.0.1:4022",
  merchant_ucp: "http://127.0.0.1:4031",
  merchant_acp: "http://127.0.0.1:4032",
});

const shutdown = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
