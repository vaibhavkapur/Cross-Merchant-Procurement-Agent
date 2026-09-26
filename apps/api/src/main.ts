import { loadConfig } from "./config.ts";
import { createRuntime } from "./bootstrap.ts";
import { buildApp } from "./app.ts";

const config = loadConfig();
const runtime = await createRuntime(config);
const app = await buildApp({ runtime, logger: true });
await app.listen({ port: config.port, host: config.host });
runtime.logger.info("listening", { address: `http://${config.host}:${config.port}` });
