import { describe, it, expect, vi } from "vitest";
import {
  startCollateralCooldownWorker,
  CollateralCooldownWorkerOptions,
} from "./cooldownWorker.js";
import { CollateralGuardStore } from "../collateralGuard.js";

describe("collateral cooldown monitor worker (#420)", () => {
  it("unlocks deposits once their cooldown bound has expired", async () => {
    const store = new CollateralGuardStore();
    const onUnlocked = vi.fn();
    await store.recordDeposit({ providerId: "p", assetAddress: "A", amountStroops: "1", depositLedger: 995 });
    await store.recordDeposit({ providerId: "p", assetAddress: "B", amountStroops: "1", depositLedger: 997 });

    // Ledger 1000: the first deposit (expires at 1000) unlocks; the second
    // (expires at 1002) is still inside its flash-loan lockup.
    let ledger = 1_000;
    const options: CollateralCooldownWorkerOptions = {
      store,
      onUnlocked,
      pollIntervalMs: 5,
      getCurrentLedger: async () => ledger,
    };
    const stop = startCollateralCooldownWorker(options);
    await vi.waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(1));

    // Advance two ledgers; the next tick releases the remaining deposit.
    // Poll the observable end-state rather than mock-call counts: any
    // single tick unlocks at most the batch that has expired by then.
    ledger = 1_002;
    await vi.waitFor(async () => {
      const result = await store.runReleaseCheck("p", ledger);
      expect(result.depositsChecked).toBe(0);
    });
    stop();
  });

  it("reports failures through onError instead of throwing", async () => {
    const onError = vi.fn();
    const stop = startCollateralCooldownWorker({
      store: new CollateralGuardStore(),
      onError,
      getCurrentLedger: async () => {
        throw new Error("rpc unavailable");
      },
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
    stop();
  });
});
