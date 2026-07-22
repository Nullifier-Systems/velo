import type { FastifyInstance } from "fastify";
import { server, NETWORK_PASSPHRASE } from "../lib/stellar.js";
import { getRecentActivity } from "../lib/store.js";
import { Networks } from "@stellar/stellar-sdk";

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
      };

      try {
        const [health, latest] = await Promise.all([
          server.getHealth(),
          server.getLatestLedger(),
        ]);
        chain = {
          network: NETWORK_PASSPHRASE === Networks.PUBLIC ? "public" : "testnet",
          status: health.status,
          latest_ledger: latest.sequence,
          oldest_ledger: "oldestLedger" in health ? (health as any).oldestLedger : null,
        };
      } catch (err) {
        app.log.warn(err, "status: soroban RPC unreachable");
        chain = {
          network: NETWORK_PASSPHRASE === Networks.PUBLIC ? "public" : "testnet",
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
