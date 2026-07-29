import type { FastifyInstance } from "fastify";
import { server, NETWORK_PASSPHRASE } from "../lib/stellar.js";
import { getRecentActivity } from "../lib/store.js";
import { Networks, Contract, TransactionBuilder, Account, Operation } from "@stellar/stellar-sdk";

const startedAt = Date.now();

/**
 * GET /api/v1/status — free, public transparency endpoint.
 *
 * Combines process uptime, Soroban RPC health/latest-ledger info, and a
 * sanitized feed of recent trade activity into one payload for a public
 * status page. Intentionally exposes no seller/buyer addresses, amounts,
 * or secret material — see lib/store.ts#getRecentActivity.
 *
 * Chain reads are best-effort: if the configured RPC node is unreachable,
 * `chain.status` reports "unreachable" instead of failing the whole request,
 * so the page still renders API-side health during an RPC outage.
 */
export async function statusRoutes(app: FastifyInstance) {
  app.get(
    "/status",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async () => {
      const api = {
        status: "ok" as const,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
      };

      let chain: {
        network: string;
        status: string;
        latest_ledger: number | null;
        oldest_ledger: number | null;
        proof_of_reserve?: {
          verified: boolean;
          total_locked: string;
          error?: string;
        };
      };

      try {
        const [health, latest] = await Promise.all([
          server.getHealth(),
          server.getLatestLedger(),
        ]);
        
        chain = {
          network: NETWORK_PASSPHRASE === Networks.PUBLIC ? "PUBLIC" : "TESTNET",
          status: health.status,
          latest_ledger: latest.sequence,
          oldest_ledger: "oldestLedger" in health ? (health as any).oldestLedger : null,
        };

        // Fetch proof-of-reserve verification from the contract
        const contractId = process.env.ESCROW_CONTRACT_ID;
        if (contractId) {
          try {
            const contract = new Contract(contractId);
            
            // Use a dummy source account for simulation (doesn't need to be real)
            const dummyAccount = new Account(
              "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
              "0"
            );

            // Call verify_reserve() and get_total_locked() on the contract
            const verifyTx = new TransactionBuilder(dummyAccount, {
              fee: "100",
              networkPassphrase: NETWORK_PASSPHRASE,
            })
              .addOperation(contract.call("verify_reserve"))
              .setTimeout(30)
              .build();

            const totalLockedTx = new TransactionBuilder(dummyAccount, {
              fee: "100",
              networkPassphrase: NETWORK_PASSPHRASE,
            })
              .addOperation(contract.call("get_total_locked"))
              .setTimeout(30)
              .build();

            const [verifyResult, totalLockedResult] = await Promise.all([
              server.simulateTransaction(verifyTx),
              server.simulateTransaction(totalLockedTx),
            ]);

            const verified = verifyResult.result?.retval ? scValToBool(verifyResult.result.retval) : false;
            const totalLocked = totalLockedResult.result?.retval ? scValToI128(totalLockedResult.result.retval) : "0";

            chain.proof_of_reserve = {
              verified,
              total_locked: totalLocked,
            };
          } catch (err) {
            app.log.warn(err, "status: failed to fetch proof-of-reserve from contract");
            chain.proof_of_reserve = {
              verified: false,
              total_locked: "0",
              error: "Failed to query contract",
            };
          }
        }
      } catch (err) {
        app.log.warn(err, "status: soroban RPC unreachable");
        chain = {
          network: NETWORK_PASSPHRASE === Networks.PUBLIC ? "PUBLIC" : "TESTNET",
          status: "unreachable",
          latest_ledger: null,
          oldest_ledger: null,
        };
      }

      return {
        api,
        chain,
        recent_activity: getRecentActivity(10),
      };
    }
  );
}

// Helper to convert ScVal boolean to JS boolean
function scValToBool(scVal: any): boolean {
  return scVal?.b ?? false;
}

// Helper to convert ScVal i128 to string
function scValToI128(scVal: any): string {
  if (scVal?.i128) {
    // i128 is represented as {lo: u64, hi: i64}
    const lo = BigInt(scVal.i128.lo ?? 0);
    const hi = BigInt(scVal.i128.hi ?? 0);
    const value = (hi << 64n) | lo;
    return value.toString();
  }
  return "0";
}
