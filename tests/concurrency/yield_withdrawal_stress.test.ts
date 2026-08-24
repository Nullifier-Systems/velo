import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { YIELD_VAULT } from "@velo/shared";
import {
  yieldVaultRoutes,
  setDefaultStrategyAdapter,
} from "../../apps/api/src/routes/yield-vaults.js";
import { InMemoryStrategyAdapter } from "../../apps/api/src/lib/yield/strategy-adapter.js";
import {
  clearYieldStores,
  getYieldVaultConfig,
  listProviderVaultShares,
  saveYieldVaultConfig,
  upsertProviderVaultShare,
} from "../../apps/api/src/lib/store.js";
import { planInstantSettlementDraw } from "../../apps/api/src/lib/liquidity-netting.js";

/**
 * Instant-withdrawal concurrency stress (#408 acceptance #2): trade-matching
 * demand hits the 20% liquid buffer all at once. Withdrawals must never
 * double-spend a share balance, payouts plus remaining TVL must reconcile to
 * the stroop even while a harvest races the storm, and any buffer gap must
 * be covered by an instant strategy recall — with the share exchange rate
 * ratcheting monotonically throughout.
 */

const VAULT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ADDRESS = `C${"A".repeat(55)}`;
const ADMIN_KEY = "stress-admin-key";
const PROVIDER_COUNT = 25;
const SHARES_PER_PROVIDER = 1_000_000n;
// Rate starts at exactly 2 stroops per share.
const INITIAL_TVL = BigInt(PROVIDER_COUNT) * SHARES_PER_PROVIDER * 2n;
const INITIAL_LIQUID = INITIAL_TVL / 5n; // the 20% liquid buffer
const SCALE = YIELD_VAULT.EXCHANGE_RATE_SCALE;
const HARVEST_YIELD = 1_000_000n;

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  app = Fastify();
  await app.register(yieldVaultRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.ADMIN_API_KEY;
});

async function seedVault(): Promise<void> {
  clearYieldStores();
  const adapter = new InMemoryStrategyAdapter();
  // The config below implies TVL − liquid is already deployed into the
  // external strategy — mirror that inside the simulator so instant-recall
  // legs have real funds to pull back.
  await adapter.deposit({
    assetAddress: ASSET_ADDRESS,
    amountStroops: INITIAL_TVL - INITIAL_LIQUID,
  });
  setDefaultStrategyAdapter(adapter);
  saveYieldVaultConfig({
    vaultId: VAULT_ID,
    assetAddress: ASSET_ADDRESS,
    liquidBufferRatio: YIELD_VAULT.DEFAULT_LIQUID_BUFFER_RATIO,
    currentTvlStroops: INITIAL_TVL.toString(),
    liquidStroops: INITIAL_LIQUID.toString(),
    lastExchangeRateScaled: SCALE.toString(),
  });
  for (let i = 0; i < PROVIDER_COUNT; i++) {
    upsertProviderVaultShare({
      providerId: `provider-${i}`,
      vaultId: VAULT_ID,
      shareBalance: SHARES_PER_PROVIDER.toString(),
    });
  }
}

function withdraw(providerId: string, shareAmount: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/yield/vaults/${VAULT_ID}/withdraw`,
    payload: { providerId, shareAmount },
  });
}

describe("yield withdrawal stress (#408)", () => {
  beforeEach(async () => {
    await seedVault();
  });

  it("drains every provider concurrently: exact payouts, no double-spend, buffer + recall cover everything", async () => {
    // Two full-balance attempts per provider fire simultaneously — only the
    // first wave can succeed, the second must all bounce.
    const requests: Array<Promise<any>> = [];
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < PROVIDER_COUNT; i++) {
        requests.push(
          withdraw(`provider-${i}`, SHARES_PER_PROVIDER.toString()),
        );
      }
    }
    const responses = await Promise.all(requests);

    const ok = responses.filter((r) => r.statusCode === 200);
    const conflicted = responses.filter((r) => r.statusCode === 409);
    expect(ok.length).toBe(PROVIDER_COUNT);
    expect(conflicted.length).toBe(PROVIDER_COUNT);
    for (const r of conflicted) {
      expect(r.json().code).toBe("INSUFFICIENT_SHARES");
    }

    // Payouts sum to exactly the initial TVL (constant 2 stroops/share).
    const totalPaid = ok.reduce(
      (sum, r) => sum + BigInt(r.json().data.paidStroops),
      0n,
    );
    expect(totalPaid).toBe(INITIAL_TVL);

    // Every draw plan was honoured instantly: buffer-only early, then a
    // sized instant recall once the 20% buffer ran dry.
    const sources = new Set(ok.map((r) => r.json().data.drawPlan.source));
    expect(sources.has("BUFFER_ONLY")).toBe(true);
    expect(sources.has("BUFFER_PLUS_VAULT_RECALL")).toBe(true);

    // Terminal state: fully drained, nothing negative anywhere.
    const config = getYieldVaultConfig(VAULT_ID)!;
    expect(config.currentTvlStroops).toBe("0");
    expect(config.liquidStroops).toBe("0");
    for (const share of listProviderVaultShares(VAULT_ID)) {
      expect(share.shareBalance).toBe("0");
    }
  });

  it("never lets two concurrent withdrawals of one balance both succeed", async () => {
    const [a, b] = await Promise.all([
      withdraw("provider-7", SHARES_PER_PROVIDER.toString()),
      withdraw("provider-7", SHARES_PER_PROVIDER.toString()),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const balance = listProviderVaultShares(VAULT_ID).find(
      (s) => s.providerId === "provider-7",
    )!.shareBalance;
    expect(balance).toBe("0");
  });

  it("keeps the exchange rate monotonic while a harvest races the storm", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/v1/yield/vaults",
    });
    const rateBefore = BigInt(before.json().data[0].exchangeRateScaled);

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/yield/harvest",
        headers: { "x-admin-api-key": ADMIN_KEY },
        payload: { vaultId: VAULT_ID, yieldStroops: HARVEST_YIELD.toString() },
      }),
      ...Array.from({ length: PROVIDER_COUNT }, (_, i) =>
        withdraw(`provider-${i}`, "400000"),
      ),
    ]);

    for (const res of responses) {
      expect([200, 409]).toContain(res.statusCode);
    }

    // Conservation, to the stroop: everything paid out plus what remains in
    // the pool equals the initial TVL plus whatever the harvest injected.
    const withdrawals = responses.slice(1);
    const totalPaid = withdrawals
      .filter((r) => r.statusCode === 200)
      .reduce((sum, r) => sum + BigInt(r.json().data.paidStroops), 0n);
    const harvested = responses[0].statusCode === 200 ? HARVEST_YIELD : 0n;

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/yield/vaults",
    });
    const view = after.json().data[0];
    expect(BigInt(view.exchangeRateScaled)).toBeGreaterThanOrEqual(rateBefore);
    expect(totalPaid + BigInt(view.currentTvlStroops)).toBe(
      INITIAL_TVL + harvested,
    );
  });

  it("plans instant draws deterministically across random splits", async () => {
    for (let i = 0; i < 200; i++) {
      const required = BigInt(Math.floor(Math.random() * 10_000_000));
      const liquid = BigInt(Math.floor(Math.random() * 5_000_000));
      const deployed = BigInt(Math.floor(Math.random() * 8_000_000));
      const plan = planInstantSettlementDraw({
        requiredStroops: required,
        liquidReserveStroops: liquid,
        deployedToVaultStroops: deployed,
      });

      if (required <= liquid) {
        expect(plan.source).toBe("BUFFER_ONLY");
        expect(plan.recallFromVaultStroops).toBe(0n);
      } else if (required <= liquid + deployed) {
        expect(plan.source).toBe("BUFFER_PLUS_VAULT_RECALL");
        expect(plan.recallFromVaultStroops).toBe(required - liquid);
      } else {
        expect(plan.source).toBe("INSUFFICIENT");
        expect(plan.shortfallStroops).toBe(required - (liquid + deployed));
      }
      // The plan never promises more than exists.
      expect(plan.recallFromVaultStroops).toBeLessThanOrEqual(deployed);
    }
  });
});


