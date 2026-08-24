/**
 * In-memory store for batch auction rounds and committed/revealed orders.
 *
 * TODO (production): back this with `batch_auction_rounds` /
 * `committed_orders` (see db/migrations/012_add_batch_auctions.sql) the same
 * way lib/store.ts's cash requests eventually move to Postgres. It exists
 * in-memory first to prove the COMMIT -> REVEAL -> MATCH -> SETTLE flow
 * end-to-end, matching the existing store.ts precedent in this codebase.
 */
import { randomUUID } from "node:crypto";
import type { BatchAuctionPhase, BatchAuctionRound, CommittedOrder, RevealedOrder } from "@velo/shared";

const rounds = new Map<string, BatchAuctionRound>();
const ordersByRound = new Map<string, Map<string, CommittedOrder>>();
const revealsByOrder = new Map<string, RevealedOrder>();

export function resetBatchAuctionStore(): void {
  rounds.clear();
  ordersByRound.clear();
  revealsByOrder.clear();
}

export function createRound(params: { commitMs: number; revealMs: number }): BatchAuctionRound {
  const now = Date.now();
  const round: BatchAuctionRound = {
    roundId: randomUUID(),
    phase: "COMMIT",
    clearingPriceStroops: null,
    commitDeadline: new Date(now + params.commitMs).toISOString(),
    revealDeadline: new Date(now + params.commitMs + params.revealMs).toISOString(),
    createdAt: new Date(now).toISOString(),
  };
  rounds.set(round.roundId, round);
  ordersByRound.set(round.roundId, new Map());
  return round;
}

export function getRound(roundId: string): BatchAuctionRound | undefined {
  return rounds.get(roundId);
}

export function getCurrentCommitRound(): BatchAuctionRound | undefined {
  for (const round of rounds.values()) {
    if (round.phase === "COMMIT") return round;
  }
  return undefined;
}

/** Most recently created round, regardless of phase — for status display. */
export function getLatestRound(): BatchAuctionRound | undefined {
  let latest: BatchAuctionRound | undefined;
  for (const round of rounds.values()) {
    if (!latest || Date.parse(round.createdAt) >= Date.parse(latest.createdAt)) latest = round;
  }
  return latest;
}

export function setRoundPhase(
  roundId: string,
  phase: BatchAuctionPhase,
  extra: Partial<Pick<BatchAuctionRound, "clearingPriceStroops" | "settledAt">> = {},
): BatchAuctionRound | undefined {
  const round = rounds.get(roundId);
  if (!round) return undefined;
  const updated = { ...round, phase, ...extra };
  rounds.set(roundId, updated);
  return updated;
}

export function addCommittedOrder(order: {
  roundId: string;
  commitHash: string;
  depositAmountStroops: string;
}): CommittedOrder {
  const record: CommittedOrder = {
    orderId: randomUUID(),
    roundId: order.roundId,
    commitHash: order.commitHash,
    depositAmountStroops: order.depositAmountStroops,
    committedAt: new Date().toISOString(),
    revealed: false,
    forfeited: false,
  };
  const bucket = ordersByRound.get(order.roundId) ?? new Map();
  bucket.set(record.orderId, record);
  ordersByRound.set(order.roundId, bucket);
  return record;
}

export function getCommittedOrder(roundId: string, orderId: string): CommittedOrder | undefined {
  return ordersByRound.get(roundId)?.get(orderId);
}

export function getCommittedOrders(roundId: string): CommittedOrder[] {
  return Array.from(ordersByRound.get(roundId)?.values() ?? []);
}

export function markRevealed(roundId: string, orderId: string, reveal: RevealedOrder): void {
  const bucket = ordersByRound.get(roundId);
  const order = bucket?.get(orderId);
  if (!bucket || !order) return;
  bucket.set(orderId, { ...order, revealed: true });
  revealsByOrder.set(orderId, reveal);
}

export function getReveal(orderId: string): RevealedOrder | undefined {
  return revealsByOrder.get(orderId);
}

export function getReveals(roundId: string): RevealedOrder[] {
  return getCommittedOrders(roundId)
    .filter((o) => o.revealed)
    .map((o) => revealsByOrder.get(o.orderId))
    .filter((r): r is RevealedOrder => Boolean(r));
}

/** Marks every commitment in the round that never revealed as forfeited. */
export function forfeitUnrevealed(roundId: string): string[] {
  const bucket = ordersByRound.get(roundId);
  if (!bucket) return [];
  const forfeited: string[] = [];
  for (const [orderId, order] of bucket) {
    if (!order.revealed && !order.forfeited) {
      bucket.set(orderId, { ...order, forfeited: true });
      forfeited.push(orderId);
    }
  }
  return forfeited;
}
