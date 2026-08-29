import { describe, it, expect, beforeEach } from "vitest";
import { createHash, randomBytes } from "crypto";
import {
  SwapDisputeStore,
  memorySwapDisputeStore,
} from "../../apps/api/src/lib/workers/swapDisputeWorker.js";

describe("Cross-Ledger Atomic Swap Dispute Bridge Concurrency Stress Tests (#446)", () => {
  let store: SwapDisputeStore;

  beforeEach(() => {
    memorySwapDisputeStore.clear();
    store = new SwapDisputeStore();
  });

  function generatePreimageAndHash(): { preimage: string; secretHash: string } {
    const preimageBytes = randomBytes(32);
    const preimage = preimageBytes.toString("hex");
    const secretHash = createHash("sha256").update(preimageBytes).digest("hex");
    return { preimage, secretHash };
  }

  it("handles 50 concurrent swap secret extraction requests with zero duplicate settlements", async () => {
    const swapCount = 50;
    const swaps: Array<{ swapId: string; preimage: string; secretHash: string; exp: number }> = [];

    // Register 50 swaps
    for (let i = 0; i < swapCount; i++) {
      const { preimage, secretHash } = generatePreimageAndHash();
      const swapId = `swap-concurrency-${i}-${Date.now()}`;
      const exp = 1000 + i;
      await store.registerBridge({
        swapId,
        initiatorAddress: `GAINITIATOR${i.toString().padStart(40, "0")}`,
        counterpartyAddress: `GBCOUNTERPARTY${i.toString().padStart(40, "0")}`,
        secretHash,
        expirationLedger: exp,
      });
      swaps.push({ swapId, preimage, secretHash, exp });
    }

    // Fire 50 simultaneous extractSecretPreimage calls
    const extractionPromises = swaps.map((s, idx) =>
      store.extractSecretPreimage(
        s.swapId,
        s.preimage,
        idx % 2 === 0 ? "ethereum" : "polygon",
        100000 + idx,
      ),
    );

    const results = await Promise.all(extractionPromises);
    expect(results).toHaveLength(50);
    for (const r of results) {
      expect(r.updated).toBe(true);
      expect(r.state).toBe("SECRET_EXTRACTED");
    }

    // Concurrently resolve all 50 swaps
    const resolvePromises = swaps.map((s) =>
      store.claimDisputeRefundOrResolve(s.swapId, 500),
    );
    const resolveOutcomes = await Promise.all(resolvePromises);
    expect(resolveOutcomes).toHaveLength(50);
    for (const outcome of resolveOutcomes) {
      expect(outcome.success).toBe(true);
      expect(outcome.state).toBe("RESOLVED");
      expect(outcome.action).toBe("RESOLVED_SECRET");
      expect(outcome.secretPreimage).toBeDefined();
    }
  });

  it("executes exactly 1 dispute refund when multiple concurrent callers race on single expired swap", async () => {
    const { secretHash } = generatePreimageAndHash();
    const swapId = `race-swap-${Date.now()}`;
    await store.registerBridge({
      swapId,
      initiatorAddress: "GAINITIATOR00000000000000000000000000000000000000000000",
      counterpartyAddress: "GBCOUNTERPARTY000000000000000000000000000000000000000000",
      secretHash,
      expirationLedger: 500,
    });

    // 20 concurrent claims racing at ledger 550 (expired)
    const racers = Array.from({ length: 20 }, () =>
      store.claimDisputeRefundOrResolve(swapId, 550),
    );

    const raceResults = await Promise.all(racers);
    const firstClaim = raceResults.filter((r) => r.action === "REFUNDED_TIMEOUT");
    const duplicateClaims = raceResults.filter((r) => r.action === "ALREADY_RESOLVED");

    expect(firstClaim).toHaveLength(1);
    expect(duplicateClaims).toHaveLength(19);
    for (const r of raceResults) {
      expect(r.success).toBe(true);
      expect(r.state).toBe("RESOLVED");
    }
  });

  it("rejects dispute refund attempt before timeout expiration ledger", async () => {
    const { secretHash } = generatePreimageAndHash();
    const swapId = `early-swap-${Date.now()}`;
    await store.registerBridge({
      swapId,
      initiatorAddress: "GAINITIATOR00000000000000000000000000000000000000000000",
      counterpartyAddress: "GBCOUNTERPARTY000000000000000000000000000000000000000000",
      secretHash,
      expirationLedger: 1000,
    });

    await expect(
      store.claimDisputeRefundOrResolve(swapId, 999),
    ).rejects.toThrow(/Cannot claim dispute refund: current ledger 999 < expiration ledger 1000/);
  });

  it("fails secret extraction when preimage does not hash to secret_hash", async () => {
    const { secretHash } = generatePreimageAndHash();
    const swapId = `invalid-secret-swap-${Date.now()}`;
    await store.registerBridge({
      swapId,
      initiatorAddress: "GAINITIATOR00000000000000000000000000000000000000000000",
      counterpartyAddress: "GBCOUNTERPARTY000000000000000000000000000000000000000000",
      secretHash,
      expirationLedger: 1000,
    });

    const wrongPreimage = "ff".repeat(32);
    await expect(
      store.extractSecretPreimage(swapId, wrongPreimage, "ethereum"),
    ).rejects.toThrow(/Cryptographic verification failed/);
  });

  it("worker auto-sweep discovers expired swaps and triggers refund resolution", async () => {
    const { secretHash: hash1 } = generatePreimageAndHash();
    const { secretHash: hash2 } = generatePreimageAndHash();

    await store.registerBridge({
      swapId: "sweep-swap-1",
      initiatorAddress: "GA1",
      counterpartyAddress: "GB1",
      secretHash: hash1,
      expirationLedger: 200,
    });

    await store.registerBridge({
      swapId: "sweep-swap-2",
      initiatorAddress: "GA2",
      counterpartyAddress: "GB2",
      secretHash: hash2,
      expirationLedger: 400,
    });

    // Sweep at ledger 250 -> only sweep-swap-1 is resolved
    const swept = await store.sweepExpiredSwaps(250);
    expect(swept).toHaveLength(1);
    expect(swept[0].swapId).toBe("sweep-swap-1");
    expect(swept[0].action).toBe("REFUNDED_TIMEOUT");

    const bridge1 = await store.getBridge("sweep-swap-1");
    const bridge2 = await store.getBridge("sweep-swap-2");
    expect(bridge1?.state).toBe("RESOLVED");
    expect(bridge2?.state).toBe("ACTIVE");
  });
});
