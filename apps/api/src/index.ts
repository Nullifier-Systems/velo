import { app } from "./app.js";
import { cashRoutes } from "./routes/cash.js";
import { adminRoutes } from "./routes/admin.js";
import { startPayoutBatchScheduler } from "./lib/payout-batcher.js";
import { EscrowAnomalyMonitor } from "./lib/escrow-anomaly-monitor.js";
import { CONTRACTS } from "@velo/shared";
import { server } from "./lib/stellar.js";

const port = Number(process.env.PORT ?? 3000);

// Initialize and register routes before starting the server
async function startServer() {
  try {
    // Register User Cash & Geolocation discovery routes (with /api/v1 prefix)
    await app.register(cashRoutes, { prefix: "/api/v1" });

    // Register Admin/Ops monitoring & intervention routes (with /api/v1 prefix)
    await app.register(adminRoutes, { prefix: "/api/v1" });

    // Start listening
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info(`velo api listening on :${port}`);

    // Background scheduler for opt-in provider payout batching — see
    // docs/provider-payout-batching.md. Not started for the test app
    // instance (app.test.ts imports ./app.js directly, not this entrypoint).
    startPayoutBatchScheduler();

    // Poll the escrow's contract + failed diagnostic events through the same
    // Soroban RPC connection used by the API and route findings to the shared
    // operations webhook.
    new EscrowAnomalyMonitor(server, {
      contractId: process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow,
      startLedger: process.env.ESCROW_MONITOR_START_LEDGER
        ? Number(process.env.ESCROW_MONITOR_START_LEDGER)
        : undefined,
    }).start();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

startServer();
