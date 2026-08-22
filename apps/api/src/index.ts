import { app, stellarEventStore, pgPool } from "./app.js";
import { startPayoutBatchScheduler } from "./lib/payout-batcher.js";
import { startRefundCountdownScheduler } from "./lib/refund-scheduler.js";
import { EscrowAnomalyMonitor } from "./lib/escrow-anomaly-monitor.js";
import { CONTRACTS, CIRCUIT_BREAKER } from "@velo/shared";
import { server } from "./lib/stellar.js";
import { StellarIndexerWorker, PgAdvisoryLock } from "./lib/workers/stellarIndexerWorker.js";
import { startChatCleanupWorker } from "./lib/workers/chatCleanupWorker.js";
import { startSessionRotationWorker } from "./lib/workers/sessionRotationWorker.js";
import { createSessionKeyRegistryStore } from "./lib/session-registry-store.js";
import { createClient } from "redis";
import { CircuitBreakerStore } from "./lib/circuit-breaker-store.js";
import { broadcastCircuitBreakerPause, readEscrowTokenBalance } from "./lib/stellar.js";
import { evaluateReserveConservation } from "./lib/invariant-checker.js";
import { createEnterpriseStore } from "./lib/enterprise-store.js";
import { startApprovalTimeoutWorker } from "./lib/workers/approvalTimeoutWorker.js";

const port = Number(process.env.PORT ?? 3000);

async function startServer() {
  try {
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info(`velo api listening on :${port}`);

    startPayoutBatchScheduler();
    startChatCleanupWorker();

    // (#380) Watch locked trades for approaching refund timeouts: warn 100
    // ledgers before expiry, auto-refund once the timeout is breached, and
    // verify the seller_payouts + buyer_refund + fees == original invariant.
    startRefundCountdownScheduler();

    if (stellarEventStore && pgPool) {
      const contractId = process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow;
      const stateStore = new CircuitBreakerStore(pgPool);

      // (#374) Real-time Soroban ledger indexer with single-leader election,
      // formal reserve-conservation invariant verification, and automated
      // circuit-breaker arbitration. Starts the advisory-lock worker; the
      // legacy StellarEscrowIndexer remains available for recovery tooling.
      const worker = new StellarIndexerWorker({
        contractId,
        rpc: server,
        store: stellarEventStore,
        stateStore,
        lock: new PgAdvisoryLock(pgPool),
        logger: app.log,
        pollIntervalMs: process.env.STELLAR_INDEXER_POLL_INTERVAL_MS
          ? Number(process.env.STELLAR_INDEXER_POLL_INTERVAL_MS)
          : CIRCUIT_BREAKER.LEADER_ELECTION_POLL_MS,
        evaluateInvariant: evaluateReserveConservation,
        readActualBalance:
          process.env.USDC_TOKEN_CONTRACT_ID
            ? async (escrowId) =>
                readEscrowTokenBalance(escrowId, process.env.USDC_TOKEN_CONTRACT_ID!)
            : undefined,
        triggerCircuitBreaker: async (escrowId, result) =>
          broadcastCircuitBreakerPause({ contractId: escrowId, action: "FORCE_PAUSE" }, app.log),
      });
      void worker.start();

      // #374 — poll the escrow's contract + failed diagnostic events through
      // the same Soroban RPC connection used by the API and route findings
      // into the circuit-breaker arbitration engine (incident audit trail).
      new EscrowAnomalyMonitor(server, {
        contractId,
        startLedger: process.env.ESCROW_MONITOR_START_LEDGER
          ? Number(process.env.ESCROW_MONITOR_START_LEDGER)
          : undefined,
        onAnomaly: async (finding) => {
          await stateStore.logIncident({
            contractId: finding.contractId,
            violatedInvariant: `ANOMALY:${finding.pattern}`,
            evidence: finding.evidence,
            actionTaken: "NO_ACTION",
            txPauseHash: null,
          });
        },
      }).start();
    } else {
      app.log.warn("DATABASE_URL is not configured; Stellar indexer, circuit breaker and GraphQL are disabled");
    }

    // (#375) Session-key multi-sig emergency rotation: drain
    // velo:session-rotation-queue, confirm each proposal on-chain and retire
    // the old key. Needs both the registry (Postgres) and the queue (Redis).
    if (pgPool && process.env.REDIS_URL) {
      try {
        const rotationQueue = createClient({ url: process.env.REDIS_URL });
        rotationQueue.on("error", (error) => app.log.error(error, "session rotation queue error"));
        await rotationQueue.connect();
        startSessionRotationWorker({
          store: createSessionKeyRegistryStore(pgPool),
          redis: rotationQueue,
        });
      } catch (error) {
        // A Redis outage must not stop the API from serving requests.
        app.log.error(error, "session-key rotation worker failed to start");
      }
    } else {
      app.log.warn("DATABASE_URL or REDIS_URL is not configured; session-key rotation worker is disabled");
    }

    // (#401) Dual-control expiration: expire PENDING approvals after 24h, poll 60s
    try {
      const enterpriseStore = createEnterpriseStore(pgPool as never);
      startApprovalTimeoutWorker({ store: enterpriseStore });
    } catch (error) {
      app.log.error(error, "approval timeout worker failed to start");
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

startServer();
