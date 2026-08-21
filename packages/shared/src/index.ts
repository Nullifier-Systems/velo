/**
 * Single source of truth for deployed contract addresses.
 * apps/api, mobile/backend, and mobile/frontend all import from here —
 * never hardcode a contract address in app code.
 *
 * Stellar Mainnet USDC issuer:
 *   GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN (Circle)
 *
 * USDC on Stellar is a classic asset (not a Soroban token) unless wrapped.
 * For Soroban contracts the token address is the Stellar Asset Contract (SAC)
 * address, which is deterministic:  https://github.com/stellar/stellar-protocol/blob/master/core/cap-0046.md
 *
 * The SAC address for USDC on mainnet is:
 *   CCW67TSZV3SSWZ6NAU4B46GSAV4IX3ODU6OVU5Q2ZWCEO6PJ6W7JXK2O
 * (derived from the USDC classic asset descriptor via the SAC factory).
 *
 * ⚠️ Placeholder values below — replace with real deployed contract IDs
 *    AFTER the mainnet deployment transaction succeeds (step 4 of the
 *    go-live checklist in docs/mainnet-deployment.md).
 */
export const CONTRACTS = {
  testnet: {
    escrow: "CBJQHRGVAHLN5ZEIAIEBMR63Y2HVHUDZPRE6ZFULBS7LE756AT5ZIAGG",
    atomicSwapA: "CCXS4GEXS6SJBAKD37N4273GGXHWUIETWCGQJPIEIUKOLKAW6XUN7YH7",
    zkVerifierRegistry: "SET_ME_AFTER_FIRST_DEPLOY",
  },
  mainnet: {
    escrow: "DEPLOY_ESCROW_FIRST",
    atomicSwapA: "DEPLOY_ATOMIC_SWAP_FIRST",
    zkVerifierRegistry: "",
  },
} as const;

/** Stellar Mainnet USDC metadata */
export const USDC_MAINNET = {
  issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  /** Stellar Asset Contract address for USDC on mainnet */
  sac: "CCW67TSZV3SSWZ6NAU4B46GSAV4IX3ODU6OVU5Q2ZWCEO6PJ6W7JXK2O",
  code: "USDC",
} as const;

export type Network = keyof typeof CONTRACTS;

export interface CashRequest {
  id: string;
  claim_url: string;
  qr_payload: string;
  status: "pending" | "locked" | "released" | "refunded";
}

/* ------------------------------------------------------------------ */
/*  Real-time ledger indexer & circuit breaker (#374)                 */
/* ------------------------------------------------------------------ */

/** Formal invariant verdict emitted by the checker every closed ledger. */
export type InvariantCheckStatus = "HEALTHY" | "WARNING" | "VIOLATED" | "HALTED";

/** What the automated arbitration engine decided to do with a violation. */
export type CircuitBreakerAction =
  | "NO_ACTION"
  | "PAUSE_SINGLE_ESCROW"
  | "GLOBAL_SYSTEM_PAUSE";

/** Manual admin override actions accepted by POST /admin/circuit-breaker/override. */
export type CircuitBreakerOverrideAction = "FORCE_PAUSE" | "UNPAUSE";

/**
 * Shared constants for the real-time indexer + circuit-breaker stack.
 * Single source of truth so the migration SQL, worker, API routes, and
 * frontend can never drift apart.
 */
export const CIRCUIT_BREAKER = {
  /** Postgres advisory lock ID used for single-leader indexer election. */
  ADVISORY_LOCK_ID: 889001,
  /** How often a standby worker retries for leader election (ms). */
  LEADER_ELECTION_POLL_MS: 5_000,
  /** SLA: emergency on-chain pause must be submitted within 1000ms of a violation. */
  PAUSE_TRIGGER_DEADLINE_MS: 1_000,
  /** Soroban RPC ledger-stream endpoint (testnet by default). */
  LEDGER_STREAM_URL: process.env.SOROBAN_LEDGER_STREAM_URL ?? "wss://soroban-testnet.stellar.org",
  /** Redis stream used as the malformed-ledger-frame dead-letter queue. */
  DLQ_CHANNEL: "velo:indexer-dlq",
} as const;

/* ------------------------------------------------------------------ */
/*  ZK Nullifier Escrow Settlement (#371)                              */
/* ------------------------------------------------------------------ */

export type ZkNullifierStatus = "PENDING" | "SETTLED" | "REJECTED";

export interface ZkSettleRequest {
  proof: string;
  nullifierHash: string;
  commitment: string;
  credentialSecret?: string;
}

export interface ZkSettleResponse {
  message: string;
  nullifierHash: string;
  status: ZkNullifierStatus;
}

export interface ZkSettleStatusResponse {
  nullifierHash: string;
  status: ZkNullifierStatus;
  txHash?: string | null;
  errorMessage?: string | null;
}

export const ZK_SETTLEMENT = {
  STREAM_KEY: "velo:zk-settlement-queue",
  GROUP_NAME: "zk-settlement-group",
  DLQ_KEY: "velo:zk-settlement-dlq",
  MAX_RETRIES: 5,
} as const;
