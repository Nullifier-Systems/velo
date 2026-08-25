import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { clearBatch, computeCommitHash, verifyReveal } from "../batch-auction-engine.js";
import type { CommittedOrder, RevealedOrder } from "@velo/shared";

function reveal(overrides: Partial<RevealedOrder> = {}): RevealedOrder {
  return {
    orderId: randomUUID(),
    roundId: "round-1",
    side: "BUY",
    rateStroops: "100",
    amountStroops: "1000",
    saltHex: "deadbeef",
    ...overrides,
  };
}

function committedFor(reveal: RevealedOrder, opts: Partial<CommittedOrder> = {}): CommittedOrder {
  return {
    orderId: reveal.orderId,
    roundId: reveal.roundId,
    commitHash: computeCommitHash(reveal),
    depositAmountStroops: "10",
    committedAt: new Date().toISOString(),
    revealed: true,
    forfeited: false,
    ...opts,
  };
}

describe("computeCommitHash / verifyReveal", () => {
  it("is deterministic for identical inputs", () => {
    const order = { side: "BUY" as const, rateStroops: "100", amountStroops: "1000", saltHex: "abc123" };
    expect(computeCommitHash(order)).toBe(computeCommitHash(order));
  });

  it("changes when any field changes", () => {
    const base = { side: "BUY" as const, rateStroops: "100", amountStroops: "1000", saltHex: "abc123" };
    const hash = computeCommitHash(base);
    expect(computeCommitHash({ ...base, rateStroops: "101" })).not.toBe(hash);
    expect(computeCommitHash({ ...base, amountStroops: "1001" })).not.toBe(hash);
    expect(computeCommitHash({ ...base, saltHex: "abc124" })).not.toBe(hash);
    expect(computeCommitHash({ ...base, side: "SELL" })).not.toBe(hash);
  });

  it("rejects a reveal that does not match its commitment", () => {
    const r = reveal();
    const wrongHash = computeCommitHash({ ...r, rateStroops: "999" });
    expect(verifyReveal(wrongHash, r)).toBe(false);
    expect(verifyReveal(computeCommitHash(r), r)).toBe(true);
  });
});

describe("clearBatch — uniform clearing price", () => {
  it("clears every fill at a single uniform price", () => {
    const bids = [
      reveal({ side: "BUY", rateStroops: "120", amountStroops: "500" }),
      reveal({ side: "BUY", rateStroops: "110", amountStroops: "500" }),
      reveal({ side: "BUY", rateStroops: "90", amountStroops: "500" }), // below crossing, unfilled
    ];
    const asks = [
      reveal({ side: "SELL", rateStroops: "80", amountStroops: "400" }),
      reveal({ side: "SELL", rateStroops: "100", amountStroops: "400" }),
      reveal({ side: "SELL", rateStroops: "130", amountStroops: "400" }), // above crossing, unfilled
    ];
    const revealed = [...bids, ...asks];
    const committed = revealed.map((r) => committedFor(r));

    const result = clearBatch(committed, revealed);

    expect(result.clearingPriceStroops).not.toBeNull();
    expect(result.fills.length).toBeGreaterThan(0);
    const distinctPrices = new Set(result.fills.map((f: any) => f.clearingPriceStroops));
    expect(distinctPrices.size).toBe(1);
    // The two lowest asks and two highest bids should clear; the extremes should not.
    const filledIds = new Set(result.fills.map((f: any) => f.orderId));
    expect(filledIds.has(bids[2].orderId)).toBe(false);
    expect(filledIds.has(asks[2].orderId)).toBe(false);
  });

  it("never fills more than the smaller side's cumulative volume", () => {
    const bids = [reveal({ side: "BUY", rateStroops: "100", amountStroops: "1000" })];
    const asks = [reveal({ side: "SELL", rateStroops: "50", amountStroops: "300" })];
    const revealed = [...bids, ...asks];
    const committed = revealed.map((r) => committedFor(r));

    const result = clearBatch(committed, revealed);
    const totalBuyFill = result.fills
      .filter((f: any) => f.side === "BUY")
      .reduce((sum: bigint, f: any) => sum + BigInt(f.filledAmountStroops), 0n);
    const totalSellFill = result.fills
      .filter((f: any) => f.side === "SELL")
      .reduce((sum: bigint, f: any) => sum + BigInt(f.filledAmountStroops), 0n);

    expect(totalBuyFill).toBe(300n);
    expect(totalSellFill).toBe(300n);
  });

  it("returns no clearing price when the book does not cross", () => {
    const bids = [reveal({ side: "BUY", rateStroops: "50", amountStroops: "500" })];
    const asks = [reveal({ side: "SELL", rateStroops: "100", amountStroops: "500" })];
    const revealed = [...bids, ...asks];
    const committed = revealed.map((r) => committedFor(r));

    const result = clearBatch(committed, revealed);
    expect(result.clearingPriceStroops).toBeNull();
    expect(result.fills).toHaveLength(0);
  });

  it("returns no clearing price with only one side revealed", () => {
    const revealed = [reveal({ side: "BUY" })];
    const committed = revealed.map((r) => committedFor(r));
    const result = clearBatch(committed, revealed);
    expect(result.clearingPriceStroops).toBeNull();
  });
});

describe("clearBatch — un-revealed commitment forfeiture", () => {
  it("flags committed orders that never revealed as forfeited, not merely unmatched", () => {
    const revealedOrder = reveal({ side: "BUY", rateStroops: "100", amountStroops: "500" });
    const askOrder = reveal({ side: "SELL", rateStroops: "50", amountStroops: "500" });
    const revealed = [revealedOrder, askOrder];

    const neverRevealed = committedFor(reveal(), { revealed: false });
    const committed = [committedFor(revealedOrder), committedFor(askOrder), neverRevealed];

    const result = clearBatch(committed, revealed);
    expect(result.forfeitedOrderIds).toEqual([neverRevealed.orderId]);
    expect(result.fills.some((f: any) => f.orderId === neverRevealed.orderId)).toBe(false);
  });

  it("does not re-forfeit a commitment already marked forfeited", () => {
    const alreadyForfeited = committedFor(reveal(), { revealed: false, forfeited: true });
    const result = clearBatch([alreadyForfeited], []);
    expect(result.forfeitedOrderIds).toHaveLength(0);
  });
});
