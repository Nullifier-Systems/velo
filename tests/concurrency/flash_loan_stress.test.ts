import { describe, it, expect, vi } from "vitest";
import {
  CollateralGuardStore,
  FLASH_LOAN_COOLDOWN_LEDGERS,
  canReleaseCollateral,
  cooldownRemainingLedgers,
} from "../../apps/api/src/lib/collateralGuard.js";
import {
  startCollateralCooldownWorker,
} from "../../apps/api/src/lib/workers/cooldownWorker.js";

/**
 * Flash-Loan Stress Test (Issue #420).
 *
 * Executes 50 rapid deposit→release pairs inside a SINGLE simulated Stellar
 * ledger and asserts that 100% of same-ledger release attempts are blocked
 * by the collateral cooldown gate. Also verifies:
 *   - releases one ledger short of the lockup still fail (no off-by-one),
 *   - every deposit unlocks exactly at deposit_ledger + 5,
 *   - the cooldown monitor worker flips is_locked once bounds expire,
 *   - mixed-ledger bursts only block the sub-cooldown subset.
 */
describe("Flash-Loan Concurrency Stress Test (Issue #420)", () => {
  const SIMULATED_LEDGER = 7_500_000;
  const PROVIDERS = Array.from({ length: 50 }, (_, i) => `provider-${i}`);

  it("blocks 100% of same-ledger releases across 50 concurrent attempts", async () => {
    const store = new CollateralGuardStore();

    // All 50 deposits land in the SAME simulated ledger sequence, racing
    // through Promise.all like a flash-loan bot burst.
    await Promise.all(
      PROVIDERS.map((providerId) =>
        store.recordDeposit({
          providerId,
          assetAddress: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZ4MWQ5VBSNFYQ2YL",
          amountStroops: String(1_000_000 + Math.floor(Math.random() * 1000)),
          depositLedger: SIMULATED_LEDGER,
        }),
      ),
    );

    // Every provider immediately attempts a release in that same ledger.
    const results = await Promise.all(
      PROVIDERS.map(async (providerId) => ({
        providerId,
        check: await store.runReleaseCheck(providerId, SIMULATED_LEDGER),
      })),
    );

    const blocked = results.filter((r) => !r.check.eligible);
    expect(blocked.length).toBe(50);

    for (const r of results) {
      expect(r.check.remainingLedgers).toBe(FLASH_LOAN_COOLDOWN_LEDGERS);
      expect(r.check.earliestReleaseLedger).toBe(
        SIMULATED_LEDGER + FLASH_LOAN_COOLDOWN_LEDGERS,
      );
    }
  });

  it("still blocks releases one ledger short of the full 5-ledger lockup", () => {
    // No off-by-one: L+4 is blocked, L+5 is free.
    expect(canReleaseCollateral(SIMULATED_LEDGER, SIMULATED_LEDGER + 4)).toBe(false);
    expect(canReleaseCollateral(SIMULATED_LEDGER, SIMULATED_LEDGER + 5)).toBe(true);
    expect(cooldownRemainingLedgers(SIMULATED_LEDGER, SIMULATED_LEDGER + 4)).toBe(1);
  });

  it("releases every deposit exactly at its own cooldown bound after the worker runs", async () => {
    const store = new CollateralGuardStore();
    let currentLedger = SIMULATED_LEDGER;
    const getCurrentLedger = vi.fn(async () => currentLedger);

    // Deposits staggered over 5 ledgers — each gets its own bound.
    const deposits = await Promise.all(
      PROVIDERS.map((providerId, i) =>
        store.recordDeposit({
          providerId,
          assetAddress: "A",
          amountStroops: "1",
          depositLedger: SIMULATED_LEDGER + (i % 5),
        }),
      ),
    );

    // Sanity: at the moment the last deposit is made, every row is locked.
    expect(
      deposits.every((d) => d.cooldownUntilLedger > SIMULATED_LEDGER + 4),
    ).toBe(true);

    const stop = startCollateralCooldownWorker({
      store,
      pollIntervalMs: 1,
      getCurrentLedger,
    });

    // Sweep the chain tip forward one ledger at a time until every bound
    // (max SIM+9) has passed; the worker must unlock each row once its own
    // bound passes, and nothing before that.
    for (let step = 0; step <= 2 * FLASH_LOAN_COOLDOWN_LEDGERS; step++) {
      currentLedger = SIMULATED_LEDGER + step;
      await waitFor(async () => {
        const checks = await Promise.all(
          PROVIDERS.map((p, i) => store.runReleaseCheck(p, currentLedger)),
        );
        // Provider i's single deposit is checked iff its bound is in the future.
        return checks.every(
          (r, i) =>
            r.depositsChecked ===
            (deposits[i].cooldownUntilLedger > currentLedger ? 1 : 0),
        )
          ? true
          : undefined;
      }, `locked set matches cooldown bounds at ledger ${currentLedger}`);
    }
    stop();

    expect(currentLedger).toBeGreaterThanOrEqual(SIMULATED_LEDGER + FLASH_LOAN_COOLDOWN_LEDGERS);
    const finalChecks = await Promise.all(
      PROVIDERS.map((p) => store.runReleaseCheck(p, currentLedger)),
    );
    expect(finalChecks.every((r) => r.depositsChecked === 0)).toBe(true);
  });

  it("mixed-ledger burst blocks only the sub-cooldown subset", async () => {
    const store = new CollateralGuardStore();
    // Half deposited this ledger, half five ledgers ago.
    await Promise.all(
      PROVIDERS.map((providerId, i) =>
        store.recordDeposit({
          providerId,
          assetAddress: "A",
          amountStroops: "1",
          depositLedger: i % 2 === 0 ? SIMULATED_LEDGER : SIMULATED_LEDGER - 5,
        }),
      ),
    );

    const checks = await Promise.all(
      PROVIDERS.map(async (providerId) => store.runReleaseCheck(providerId, SIMULATED_LEDGER)),
    );

    const blocked = checks.filter((c) => !c.eligible);
    const allowed = checks.filter((c) => c.eligible);
    expect(blocked.length).toBe(25); // same-ledger depositers
    expect(allowed.length).toBe(25); // deposited 5 ledgers ago — cooldown elapsed
    expect(blocked.every((c) => c.remainingLedgers === FLASH_LOAN_COOLDOWN_LEDGERS)).toBe(true);
  });
});

async function waitFor(
  predicate: () => Promise<unknown>,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await predicate()) !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor timed out: ${label}`);
}
