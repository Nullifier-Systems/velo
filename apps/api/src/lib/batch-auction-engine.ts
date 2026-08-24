import { createHash } from "node:crypto";
import type {
  ClearingResult,
  CommittedOrder,
  OrderFill,
  OrderSide,
  RevealedOrder,
} from "@velo/shared";

/**
 * Core matching + uniform-price clearing logic for the commit-reveal batch
 * auction (#403). Pure functions, no I/O — the worker and store own
 * persistence and timing; this module only knows how to hash a commitment
 * and clear a set of revealed orders.
 */

/**
 * Deterministic commitment hash for an order. Both the client (at commit
 * time) and the server (at reveal time) compute this the same way, so a
 * reveal is only accepted if it hashes to the previously-committed value —
 * this is what makes order parameters unknowable during COMMIT.
 */
export function computeCommitHash(order: {
  side: OrderSide;
  rateStroops: string;
  amountStroops: string;
  saltHex: string;
}): string {
  const payload = `${order.side}:${order.rateStroops}:${order.amountStroops}:${order.saltHex}`;
  return createHash("sha256").update(payload).digest("hex");
}

/** Verifies a reveal matches the hash the order was committed under. */
export function verifyReveal(commitHash: string, reveal: RevealedOrder): boolean {
  return computeCommitHash(reveal) === commitHash;
}

/**
 * Clears a batch of revealed orders at a single uniform price.
 *
 * Standard uniform-price double-auction: sort bids (BUY) descending by rate
 * and asks (SELL) ascending by rate, walk both curves together, and find the
 * highest cumulative-volume crossing point. Every filled unit — on both
 * sides — settles at that one clearing price, so no order in the batch gets
 * a better or worse price by virtue of when/how it was revealed.
 */
export function clearBatch(
  committed: CommittedOrder[],
  revealed: RevealedOrder[],
): ClearingResult {
  const revealedIds = new Set(revealed.map((r) => r.orderId));
  const forfeitedOrderIds = committed
    .filter((c) => !c.forfeited && !revealedIds.has(c.orderId))
    .map((c) => c.orderId);

  const bids = revealed
    .filter((o) => o.side === "BUY")
    .map((o) => ({ ...o, rate: BigInt(o.rateStroops), amount: BigInt(o.amountStroops) }))
    .sort((a, b) => (a.rate === b.rate ? 0 : a.rate > b.rate ? -1 : 1));

  const asks = revealed
    .filter((o) => o.side === "SELL")
    .map((o) => ({ ...o, rate: BigInt(o.rateStroops), amount: BigInt(o.amountStroops) }))
    .sort((a, b) => (a.rate === b.rate ? 0 : a.rate < b.rate ? -1 : 1));

  if (bids.length === 0 || asks.length === 0) {
    return {
      clearingPriceStroops: null,
      fills: [],
      unmatchedOrderIds: revealed.map((o) => o.orderId),
      forfeitedOrderIds,
    };
  }

  // Cumulative demand/supply curves.
  let bidCum = 0n;
  const bidCurve = bids.map((b) => {
    bidCum += b.amount;
    return { rate: b.rate, cum: bidCum };
  });
  let askCum = 0n;
  const askCurve = asks.map((a) => {
    askCum += a.amount;
    return { rate: a.rate, cum: askCum };
  });

  // Candidate clearing rates: every distinct bid/ask rate that clears
  // (bid rate >= ask rate). Pick the crossing with maximum executable
  // volume; ties broken toward the midpoint of the marginal bid/ask.
  let bestVolume = 0n;
  let bestPrice: bigint | null = null;
  const candidateRates = new Set<bigint>([...bids.map((b) => b.rate), ...asks.map((a) => a.rate)]);

  for (const price of candidateRates) {
    const demandAtPrice = bidCurve.reduce(
      (max, b) => (b.rate >= price && b.cum > max ? b.cum : max),
      0n,
    );
    const supplyAtPrice = askCurve.reduce(
      (max, a) => (a.rate <= price && a.cum > max ? a.cum : max),
      0n,
    );
    const volume = demandAtPrice < supplyAtPrice ? demandAtPrice : supplyAtPrice;
    if (volume > bestVolume || (volume === bestVolume && bestPrice !== null && price > bestPrice)) {
      bestVolume = volume;
      bestPrice = price;
    }
  }

  if (bestPrice === null || bestVolume === 0n) {
    return {
      clearingPriceStroops: null,
      fills: [],
      unmatchedOrderIds: revealed.map((o) => o.orderId),
      forfeitedOrderIds,
    };
  }

  const clearingPrice = bestPrice;
  const fills: OrderFill[] = [];
  const unmatchedOrderIds: string[] = [];

  let remaining = bestVolume;
  for (const bid of bids) {
    if (bid.rate < clearingPrice || remaining <= 0n) {
      unmatchedOrderIds.push(bid.orderId);
      continue;
    }
    const fillAmount = bid.amount <= remaining ? bid.amount : remaining;
    remaining -= fillAmount;
    if (fillAmount > 0n) {
      fills.push({
        orderId: bid.orderId,
        side: "BUY",
        filledAmountStroops: fillAmount.toString(),
        clearingPriceStroops: clearingPrice.toString(),
      });
    }
    if (fillAmount < bid.amount) unmatchedOrderIds.push(bid.orderId);
  }

  remaining = bestVolume;
  for (const ask of asks) {
    if (ask.rate > clearingPrice || remaining <= 0n) {
      unmatchedOrderIds.push(ask.orderId);
      continue;
    }
    const fillAmount = ask.amount <= remaining ? ask.amount : remaining;
    remaining -= fillAmount;
    if (fillAmount > 0n) {
      fills.push({
        orderId: ask.orderId,
        side: "SELL",
        filledAmountStroops: fillAmount.toString(),
        clearingPriceStroops: clearingPrice.toString(),
      });
    }
    if (fillAmount < ask.amount) unmatchedOrderIds.push(ask.orderId);
  }

  return {
    clearingPriceStroops: clearingPrice.toString(),
    fills,
    unmatchedOrderIds,
    forfeitedOrderIds,
  };
}
