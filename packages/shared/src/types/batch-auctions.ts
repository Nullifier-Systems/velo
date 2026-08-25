/**
 * Types for the MEV-resistant commit-reveal batch auction engine (#403).
 *
 * Each round runs a fixed COMMIT -> REVEAL -> MATCH -> SETTLE cycle. Orders
 * are submitted as opaque commitment hashes during COMMIT, then revealed
 * (side + rate + amount + salt) during REVEAL. Every filled order in a round
 * clears at the same `clearingPriceStroops`, so no participant can profit by
 * re-ordering cleartext orders within the batch.
 */

export type BatchAuctionPhase = "COMMIT" | "REVEAL" | "MATCH" | "SETTLE" | "CLOSED";

export type OrderSide = "BUY" | "SELL";

export interface BatchAuctionRound {
  roundId: string;
  phase: BatchAuctionPhase;
  clearingPriceStroops: string | null;
  commitDeadline: string;
  revealDeadline: string;
  createdAt: string;
  settledAt?: string;
}

export interface CommittedOrder {
  orderId: string;
  roundId: string;
  /** SHA-256 hex hash of `${side}:${rateStroops}:${amountStroops}:${saltHex}`. */
  commitHash: string;
  depositAmountStroops: string;
  committedAt: string;
  revealed: boolean;
  forfeited: boolean;
}

export interface RevealedOrder {
  orderId: string;
  roundId: string;
  side: OrderSide;
  rateStroops: string;
  amountStroops: string;
  saltHex: string;
}

export interface CommitOrderRequest {
  roundId: string;
  commitHash: string;
  depositAmountStroops: string;
}

export interface RevealOrderRequest {
  orderId: string;
  roundId: string;
  side: OrderSide;
  rateStroops: string;
  amountStroops: string;
  saltHex: string;
}

export interface OrderFill {
  orderId: string;
  side: OrderSide;
  filledAmountStroops: string;
  clearingPriceStroops: string;
}

export interface ClearingResult {
  clearingPriceStroops: string | null;
  fills: OrderFill[];
  /** Order IDs that revealed but received no fill at the clearing price. */
  unmatchedOrderIds: string[];
  /** Committed order IDs that never revealed — their deposits are forfeited. */
  forfeitedOrderIds: string[];
}
