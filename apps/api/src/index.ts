import { app, stellarEventStore } from "./app.js";
import { startPayoutBatchScheduler } from "./lib/payout-batcher.js";
import { EscrowAnomalyMonitor } from "./lib/escrow-anomaly-monitor.js";
import { CONTRACTS } from "@velo/shared";
import { server } from "./lib/stellar.js";
import { StellarEscrowIndexer } from "./lib/stellar-indexer.js";

const port = Number(process.env.PORT ?? 3000);

async function startServer() {
  try {
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info(`velo api listening on :${port}`);

    startPayoutBatchScheduler();

    if (stellarEventStore) {
      const indexer = new StellarEscrowIndexer(server, stellarEventStore, app.log, {
        contractId: process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow,
        startLedger: process.env.STELLAR_INDEXER_START_LEDGER
          ? Number(process.env.STELLAR_INDEXER_START_LEDGER)
          : undefined,
        pollIntervalMs: process.env.STELLAR_INDEXER_POLL_INTERVAL_MS
          ? Number(process.env.STELLAR_INDEXER_POLL_INTERVAL_MS)
          : undefined,
      });
      void indexer.run();
    } else {
      app.log.warn("DATABASE_URL is not configured; Stellar escrow indexer and GraphQL are disabled");
    }

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
