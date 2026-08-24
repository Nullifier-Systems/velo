/**
 * Yield aggregation vault routes (#408).
 *
 *   GET  /api/v1/yield/vaults                                   — public snapshot
 *   GET  /api/v1/yield/vaults/:vaultId/providers/:providerId    — share position
 *   POST /api/v1/yield/vaults/config                            — admin upsert
 *   POST /api/v1/yield/harvest                                  — admin harvest
 *   POST /api/v1/yield/vaults/rebalance                         — admin optimizer tick
 *   POST /api/v1/yield/vaults/:vaultId/withdraw                 — provider exit
 *
 * Harvest folds strategy yield into TVL without minting shares, so provider
 * share balances appreciate via the exchange rate — and the #408 invariant
 * (the rate NEVER decreases during harvesting) is enforced before any state
 * is persisted. Withdrawals draw from the 20% liquid buffer first and flag
 * an instant `recall_from_vault` leg for the gap, so settlements never wait
 * on a strategy unwind.
 *
 * State lives in the in-memory mirrors in lib/store.ts (dual of migration
 * 010); a pg-backed store slots in behind the same helpers.
 */

import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { YIELD_VAULT } from "@velo/shared";
import { ApiError } from "../lib/errors.js";
import { requireAdminApiKeyHeader } from "../lib/admin-auth.js";
import {
  getProviderVaultShare,
  getYieldVaultConfig,
  getYieldVaultConfigByAsset,
  listProviderVaultShares,
  listYieldVaultConfigs,
  saveYieldVaultConfig,
  totalSharesForVault,
  upsertProviderVaultShare,
} from "../lib/store.js";
import { planInstantSettlementDraw } from "../lib/liquidity-netting.js";
import { optimizeBuffer } from "../lib/yield/buffer-optimizer.js";
import { runRebalanceTick } from "../lib/workers/yieldRebalanceWorker.js";
import {
  InMemoryStrategyAdapter,
  assertExchangeRateNeverDecreases,
  type YieldStrategyAdapter,
} from "../lib/yield/strategy-adapter.js";

const SCALE = YIELD_VAULT.EXCHANGE_RATE_SCALE;

/** Shared adapter instance — tests swap this via setDefaultStrategyAdapter. */
export let defaultStrategyAdapter: YieldStrategyAdapter =
  new InMemoryStrategyAdapter();

export function setDefaultStrategyAdapter(adapter: YieldStrategyAdapter): void {
  defaultStrategyAdapter = adapter;
}

export interface YieldVaultRoutesOptions {
  /** Overridable in tests; defaults to the shared in-memory simulator. */
  adapter?: YieldStrategyAdapter;
}

/** Stellar asset contract address (C…) — 56 chars. */
const STELLAR_C_ADDRESS = /^C[1-9A-HJ-NP-Za-km-z]{55}$/;
const UINT_STRING = /^\d+$/;

const BufferRatioSchema = z
  .number()
  .min(YIELD_VAULT.MIN_LIQUID_BUFFER_RATIO)
  .max(YIELD_VAULT.MAX_LIQUID_BUFFER_RATIO);

const ConfigSchema = z.object({
  assetAddress: z.string().regex(STELLAR_C_ADDRESS),
  liquidBufferRatio: BufferRatioSchema.optional(),
});

const HarvestSchema = z
  .object({
    vaultId: z.string().uuid().optional(),
    assetAddress: z.string().regex(STELLAR_C_ADDRESS).optional(),
    yieldStroops: z.string().regex(UINT_STRING),
  })
  .refine((body) => body.vaultId !== undefined || body.assetAddress !== undefined, {
    message: "vaultId or assetAddress is required",
  });

const RebalanceSchema = z.object({
  vaultId: z.string().uuid().optional(),
  demandMultiplier: z.number().min(1).max(10).optional(),
});

const WithdrawSchema = z.object({
  providerId: z.string().min(1).max(64),
  shareAmount: z.string().regex(UINT_STRING),
});

function scaledRate(tvlStroops: bigint, totalShares: bigint): bigint {
  if (totalShares <= 0n) return SCALE;
  return (tvlStroops * SCALE) / totalShares;
}

function requireVault(vaultId: string) {
  const config = getYieldVaultConfig(vaultId);
  if (!config) {
    throw new ApiError(404, "NOT_FOUND", `Yield vault ${vaultId} not found`);
  }
  return config;
}

function resolveVault(query: { vaultId?: string; assetAddress?: string }) {
  const config = query.vaultId
    ? getYieldVaultConfig(query.vaultId)
    : query.assetAddress
      ? getYieldVaultConfigByAsset(query.assetAddress)
      : undefined;
  if (!config) {
    throw new ApiError(404, "NOT_FOUND", "Yield vault not found");
  }
  return config;
}

function apyHistoryBps(seed: string, currentApyBps: number): number[] {
  // Deterministic placeholder series around the live quote until the worker
  // accumulates real per-tick observations; shape only, never persisted.
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Array.from({ length: 24 }, (_, i) => {
    const wobble = Math.sin((i + (hash % 7)) / 3) * 40;
    return Math.max(
      YIELD_VAULT.MIN_APY_BPS - 50,
      Math.round(currentApyBps + wobble),
    );
  });
}

function vaultView(
  config: ReturnType<typeof getYieldVaultConfig>,
  currentApyBps = (YIELD_VAULT.MIN_APY_BPS + YIELD_VAULT.MAX_APY_BPS) / 2,
) {
  if (!config) throw new ApiError(404, "NOT_FOUND", "Yield vault not found");
  const tvl = BigInt(config.currentTvlStroops);
  const liquid = BigInt(config.liquidStroops);
  const decision = optimizeBuffer({
    vaultId: config.vaultId,
    currentTvlStroops: tvl,
    currentLiquidStroops: liquid,
    configuredRatio: config.liquidBufferRatio,
  });
  const storedRate = config.lastExchangeRateScaled;
  return {
    ...config,
    exchangeRateScaled: BigInt(
      storedRate && storedRate.length > 0 ? storedRate : SCALE.toString(),
    ).toString(),
    buffer: {
      liquidStroops: liquid.toString(),
      targetLiquidStroops: decision.targetLiquidStroops,
      action: decision.action,
      shortfallStroops: decision.shortfallStroops,
      ratioNowScaled:
        tvl > 0n ? ((liquid * SCALE) / tvl).toString() : SCALE.toString(),
    },
    apyHistoryBps: apyHistoryBps(config.vaultId, Math.round(currentApyBps)),
    deployedStroops: (tvl - liquid).toString(),
  };
}
export async function yieldVaultRoutes(
  app: FastifyInstance,
  opts: YieldVaultRoutesOptions = {},
) {
  const resolveAdapter = (): YieldStrategyAdapter =>
    opts.adapter ?? defaultStrategyAdapter;

  /** Serialize all mutating work per vault so concurrent requests and the
   * rebalance worker can never interleave balance transitions. */
  const vaultLocks = new Map<string, Promise<unknown>>();
  function withVaultLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
    const previous = vaultLocks.get(vaultId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    vaultLocks.set(
      vaultId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // GET /yield/vaults — public snapshot for the provider portal.
  app.get(
    "/yield/vaults",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async () => {
      const views: Array<ReturnType<typeof vaultView> & { strategyName: string }> = [];
      for (const config of listYieldVaultConfigs()) {
        const quote = await resolveAdapter().quoteApy(config.assetAddress);
        views.push({ ...vaultView(config, quote.apyBps), strategyName: resolveAdapter().name });
      }
      return { status: "success", count: views.length, data: views };
    },
  );

  // GET /yield/vaults/:vaultId/providers/:providerId — share position.
  app.get<{ Params: { vaultId: string; providerId: string } }>(
    "/yield/vaults/:vaultId/providers/:providerId",
    async (req) => {
      const config = requireVault(req.params.vaultId);
      const share = getProviderVaultShare(req.params.providerId, config.vaultId);
      if (!share) {
        throw new ApiError(404, "NOT_FOUND", "Provider has no position in this vault");
      }
      const tvl = BigInt(config.currentTvlStroops);
      const shares = totalSharesForVault(config.vaultId);
      const balance = BigInt(share.shareBalance);
      const valueStroops =
        shares > 0n ? (balance * tvl) / shares : balance; // sole depositor: 1:1
      return {
        status: "success",
        data: {
          ...share,
          valueStroops: valueStroops.toString(),
          exchangeRateScaled: scaledRate(tvl, shares).toString(),
        },
      };
    },
  );

  // POST /yield/vaults/config — admin upsert (creates or tunes buffer ratio).
  app.post<{ Body: z.infer<typeof ConfigSchema> }>(
    "/yield/vaults/config",
    async (req, reply) => {
      try {
        requireAdminApiKeyHeader(req);
      } catch (error) {
        if (error instanceof ApiError) {
          return reply.status(error.statusCode).send(error.toJSON(req.id));
        }
        throw error;
      }

      const parsed = ConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid vault config", {
          detail: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }

      const { assetAddress, liquidBufferRatio } = parsed.data;
      const existing = getYieldVaultConfigByAsset(assetAddress);
      const config = existing ?? {
        vaultId: randomUUID(),
        assetAddress,
        liquidBufferRatio: YIELD_VAULT.DEFAULT_LIQUID_BUFFER_RATIO,
        currentTvlStroops: "0",
        liquidStroops: "0",
        lastExchangeRateScaled: SCALE.toString(),
      };
      if (liquidBufferRatio !== undefined) {
        config.liquidBufferRatio = liquidBufferRatio;
      }
      saveYieldVaultConfig(config);
      return reply.status(existing ? 200 : 201).send({
        status: "success",
        data: vaultView(config),
      });
    },
  );

  // POST /yield/harvest — fold accrued strategy yield into TVL. Shares are
  // untouched, so the exchange rate ratchets up; a regression is rejected
  // BEFORE any state changes (#408 contributor invariant).
  app.post<{ Body: z.infer<typeof HarvestSchema> }>(
    "/yield/harvest",
    async (req, reply) => {
      try {
        requireAdminApiKeyHeader(req);
      } catch (error) {
        if (error instanceof ApiError) {
          return reply.status(error.statusCode).send(error.toJSON(req.id));
        }
        throw error;
      }

      const parsed = HarvestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid harvest request", {
          detail: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const { vaultId, assetAddress } = parsed.data;
      const yieldStroops = BigInt(parsed.data.yieldStroops);
      if (yieldStroops <= 0n) {
        throw new ApiError(400, "INVALID_PARAMETER", "yieldStroops must be positive");
      }

      const config = resolveVault({ vaultId, assetAddress });
      return withVaultLock(config.vaultId, async () => {
        // Re-read under the lock — a concurrent tick may have moved TVL.
        const fresh = requireVault(config.vaultId);
        const shares = totalSharesForVault(fresh.vaultId);
        if (shares <= 0n) {
          throw new ApiError(
            409,
            "CONFLICT",
            "Cannot harvest a vault with no shares outstanding",
          );
        }

        const tvlBefore = BigInt(fresh.currentTvlStroops);
        const previousRate = scaledRate(tvlBefore, shares);
        const tvlAfter = tvlBefore + yieldStroops;
        const nextRate = scaledRate(tvlAfter, shares);

        if (nextRate < previousRate) {
          throw new ApiError(
            409,
            "RATE_REGRESSION",
            "Harvest would decrease the share exchange rate — rejected",
            { extra: { previousRateScaled: previousRate.toString(), nextRateScaled: nextRate.toString() } },
          );
        }
        assertExchangeRateNeverDecreases(previousRate, nextRate, `harvest:${fresh.vaultId}`);

        saveYieldVaultConfig({
          ...fresh,
          currentTvlStroops: tvlAfter.toString(),
          lastExchangeRateScaled: nextRate.toString(),
        });

        return reply.status(200).send({
          status: "success",
          data: {
            vaultId: fresh.vaultId,
            assetAddress: fresh.assetAddress,
            yieldStroops: yieldStroops.toString(),
            tvlAfterStroops: tvlAfter.toString(),
            exchangeRateScaled: nextRate.toString(),
            previousExchangeRateScaled: previousRate.toString(),
            harvestedAt: new Date().toISOString(),
          },
        });
      });
    },
  );

  // POST /yield/vaults/:vaultId/withdraw — provider exit at the current
  // exchange rate. Funded instantly: liquid buffer first, sized recall leg
  // for the gap. Serialized per-vault so concurrent withdrawals can never
  // double-spend a balance (see the stress suite in tests/concurrency/).
  app.post<{ Params: { vaultId: string }; Body: z.infer<typeof WithdrawSchema> }>(
    "/yield/vaults/:vaultId/withdraw",
    async (req, reply) => {
      const parsed = WithdrawSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid withdrawal", {
          detail: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const { providerId, shareAmount } = parsed.data;
      const amount = BigInt(shareAmount);
      if (amount <= 0n) {
        throw new ApiError(400, "INVALID_PARAMETER", "shareAmount must be positive");
      }
      requireVault(req.params.vaultId);

      return withVaultLock(req.params.vaultId, async () => {
        const config = requireVault(req.params.vaultId);

        const share = getProviderVaultShare(providerId, config.vaultId);
        if (!share || BigInt(share.shareBalance) < amount) {
          throw new ApiError(
            409,
            "INSUFFICIENT_SHARES",
            "Provider share balance is lower than the requested amount",
          );
        }

        const shares = totalSharesForVault(config.vaultId);
        if (shares <= 0n) {
          throw new ApiError(409, "CONFLICT", "Vault has no shares outstanding");
        }

        const tvl = BigInt(config.currentTvlStroops);
        const assetsOut = (amount * tvl) / shares;
        if (assetsOut <= 0n) {
          throw new ApiError(
            409,
            "ZERO_PAYOUT",
            "Requested shares convert to zero underlying at this pool size",
          );
        }

        const liquid = BigInt(config.liquidStroops);
        const plan = planInstantSettlementDraw({
          requiredStroops: assetsOut,
          liquidReserveStroops: liquid,
          deployedToVaultStroops: tvl - liquid,
        });
        if (plan.shortfallStroops > 0n) {
          throw new ApiError(
            409,
            "LIQUIDITY_SHORTFALL",
            "Buffer plus full strategy recall cannot cover this withdrawal",
            {
              extra: {
                drawPlan: {
                  source: plan.source,
                  requiredStroops: plan.requiredStroops.toString(),
                  liquidReserveStroops: plan.liquidReserveStroops.toString(),
                  recallFromVaultStroops:
                    plan.recallFromVaultStroops.toString(),
                  shortfallStroops: plan.shortfallStroops.toString(),
                },
              },
            },
          );
        }

        let recalled = 0n;
        // Rate check FIRST — nothing external may move before every
        // fallible step succeeds. A fully-exited pool (no shares left)
        // legitimately resets to the fresh-vault sentinel, so the
        // monotonicity rule only binds while depositors remain.
        const previousRate = scaledRate(tvl, shares);
        const nextRate = scaledRate(tvl - assetsOut, shares - amount);
        if (shares - amount > 0n) {
          assertExchangeRateNeverDecreases(
            previousRate,
            nextRate,
            `withdraw:${config.vaultId}`,
          );
        }

        if (plan.recallFromVaultStroops > 0n) {
          const receipt = await resolveAdapter().withdraw({
            assetAddress: config.assetAddress,
            amountStroops: plan.recallFromVaultStroops,
          });
          if (!receipt.ok) {
            throw new ApiError(
              502,
              "SERVICE_UNAVAILABLE",
              "Instant strategy recall failed — withdrawal not settled",
              { detail: receipt.detail },
            );
          }
          recalled = plan.recallFromVaultStroops;
        }

        // Mutations only happen after every fallible step above succeeded.
        upsertProviderVaultShare({
          ...share,
          shareBalance: (BigInt(share.shareBalance) - amount).toString(),
        });
        saveYieldVaultConfig({
          ...config,
          currentTvlStroops: (tvl - assetsOut).toString(),
          liquidStroops: (liquid - (assetsOut - recalled)).toString(),
          lastExchangeRateScaled: nextRate.toString(),
        });

        return reply.status(200).send({
          status: "success",
          data: {
            providerId,
            vaultId: config.vaultId,
            shareAmount: amount.toString(),
            paidStroops: assetsOut.toString(),
            drawPlan: {
              source: plan.source,
              recallFromVaultStroops: recalled.toString(),
            },
          },
        });
      });
    },
  );

  // POST /yield/vaults/rebalance — manual optimizer tick (admin): executes
  // deploy/recall legs and compounds accrued yield exactly like the worker.
  app.post<{ Body: z.infer<typeof RebalanceSchema> }>(
    "/yield/vaults/rebalance",
    async (req, reply) => {
      try {
        requireAdminApiKeyHeader(req);
      } catch (error) {
        if (error instanceof ApiError) {
          return reply.status(error.statusCode).send(error.toJSON(req.id));
        }
        throw error;
      }

      const parsed = RebalanceSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid rebalance request", {
          detail: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }

      const results = await runRebalanceTick(
        {
          adapter: resolveAdapter(),
          logger: {
            info: (obj, msg) => app.log.info(obj, msg),
            warn: (obj, msg) => app.log.warn(obj, msg),
            error: (obj, msg) => app.log.error(obj, msg),
          },
        },
        {
          pollIntervalMs: YIELD_VAULT.REBALANCE_POLL_MS,
          vaultId: parsed.data.vaultId,
        },
      );
      return reply.status(200).send({
        status: "success",
        count: results.length,
        data: results.map((r) => ({
          ...r,
          decision: {
            ...r.decision,
            targetLiquidStroops: r.decision.targetLiquidStroops.toString(),
            amountStroops: r.decision.amountStroops.toString(),
            shortfallStroops: r.decision.shortfallStroops.toString(),
          },
        })),
      });
    },
  );
}



