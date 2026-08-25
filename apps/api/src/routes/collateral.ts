/**
 * Collateral flash-loan protection routes (#420).
 *
 * POST /api/v1/cash/collateral/release-check
 *   Validates that a provider's collateral release meets the minimum
 *   5-ledger (~25s) lockup before any withdrawal or reallocation, under a
 *   `SELECT ... FOR UPDATE` row lock. Returns 200 OK when eligible, or
 *   409 Conflict while a cooldown is still active.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../lib/validation.js";
import { getLatestLedgerSequence } from "../lib/stellar.js";
import {
  CollateralGuardStore,
  FLASH_LOAN_COOLDOWN_LEDGERS,
  LEDGER_CLOSE_SECONDS,
} from "../lib/collateralGuard.js";

const releaseCheckSchema = z.object({
  provider_id: z.string().min(1).max(64),
  /** Optional explicit ledger to check against; defaults to the latest closed ledger. */
  release_ledger: z.number().int().nonnegative().max(2_147_483_647).optional(),
});

export interface CollateralRouteOptions {
  store?: CollateralGuardStore;
  getCurrentLedger?: () => Promise<number>;
}

export async function collateralRoutes(
  app: FastifyInstance,
  opts: CollateralRouteOptions = {},
) {
  const store = opts.store ?? new CollateralGuardStore();
  // Resolved lazily per request so partially-mocked stellar modules (tests)
  // never trip over exports they don't define.
  const resolveCurrentLedger =
    opts.getCurrentLedger ?? (() => getLatestLedgerSequence());

  app.post<{ Body: z.infer<typeof releaseCheckSchema> }>(
    "/cash/collateral/release-check",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = parseBody(releaseCheckSchema, req.body, reply);
      if (!body) return;

      let currentLedger = body.release_ledger;
      if (currentLedger === undefined) {
        try {
          currentLedger = await resolveCurrentLedger();
        } catch (error) {
          req.log.error(error, "failed to resolve current ledger for release-check");
          return reply.code(502).send({
            error: "failed to resolve current ledger",
            code: "LEDGER_UNAVAILABLE",
            statusCode: 502,
            retryable: true,
          });
        }
      }

      let result;
      try {
        result = await store.runReleaseCheck(body.provider_id, currentLedger);
      } catch (error) {
        req.log.error(error, "collateral release-check failed");
        return reply.code(500).send({
          error: "release check failed",
          code: "INTERNAL_ERROR",
          statusCode: 500,
          retryable: false,
        });
      }

      if (!result.eligible) {
        // Exact error shape mandated by issue #420.
        return reply.code(409).send({
          error: {
            code: "FLASH_LOAN_COOLDOWN_ACTIVE",
            message:
              "Collateral cannot be released in the same ledger sequence. Minimum 5-ledger lockup required.",
            requestId: req.id,
          },
          provider_id: body.provider_id,
          current_ledger: result.currentLedger,
          deposits_checked: result.depositsChecked,
          remaining_ledgers: result.remainingLedgers,
          earliest_release_ledger: result.earliestReleaseLedger,
          estimated_seconds_remaining:
            result.remainingLedgers * LEDGER_CLOSE_SECONDS,
        });
      }

      return reply.code(200).send({
        eligible: true,
        provider_id: body.provider_id,
        current_ledger: result.currentLedger,
        deposits_checked: result.depositsChecked,
        remaining_ledgers: 0,
        min_lockup_ledgers: FLASH_LOAN_COOLDOWN_LEDGERS,
      });
    },
  );
}
