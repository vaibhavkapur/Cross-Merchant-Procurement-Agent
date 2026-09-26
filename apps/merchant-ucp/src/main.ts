import { buildMerchantUcp } from "./server.ts";

const port = Number(process.env.PORT ?? 4031);
const host = process.env.HOST ?? "0.0.0.0";
const app = buildMerchantUcp({ logger: true });
app.listen({ port, host }).then((address) => {
  app.log.info(`merchant-ucp (UCP v2026-08-25) listening on ${address}`);
});
