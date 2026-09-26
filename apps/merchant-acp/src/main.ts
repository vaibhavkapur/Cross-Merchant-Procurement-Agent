import { buildMerchantAcp } from "./server.ts";

const port = Number(process.env.PORT ?? 4032);
const host = process.env.HOST ?? "0.0.0.0";
const app = buildMerchantAcp({ logger: true });
app.listen({ port, host }).then((address) => {
  app.log.info(`merchant-acp (ACP 2026-01-16) listening on ${address}`);
});
