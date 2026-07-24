import { app } from "./app.js";
import { startPayoutBatchScheduler } from "./lib/payout-batcher.js";
import { EscrowAnomalyMonitor } from "./lib/escrow-anomaly-monitor.js";
import { CONTRACTS } from "@velo/shared";
import { server } from "./lib/stellar.js";

const port = Number(process.env.PORT ?? 3000);

async function startServer() {
  try {
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info(`velo api listening on :${port}`);

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
