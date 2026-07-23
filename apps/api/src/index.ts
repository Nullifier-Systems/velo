import { app } from "./app.js";
import { startPayoutBatchScheduler } from "./lib/payout-batcher.js";

const port = Number(process.env.PORT ?? 3000);

async function startServer() {
  try {
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info(`velo api listening on :${port}`);

    startPayoutBatchScheduler();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

startServer();