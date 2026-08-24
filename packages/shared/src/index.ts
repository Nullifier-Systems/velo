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
export type InvariantCheckStatus =
  | "HEALTHY"
  | "WARNING"
  | "VIOLATED"
  | "HALTED";

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
  LEDGER_STREAM_URL:
    process.env.SOROBAN_LEDGER_STREAM_URL ??
    "wss://soroban-testnet.stellar.org",
  /** Redis stream used as the malformed-ledger-frame dead-letter queue. */
  DLQ_CHANNEL: "velo:indexer-dlq",
} as const;

export * from "./types/batch-auctions.js";

/**
 * Timing + phase constants for the commit-reveal batch auction engine (#403).
 */
export const BATCH_AUCTION = {
  /** Length of the COMMIT phase, in ms. */
  COMMIT_PHASE_MS: 10_000,
  /** Length of the REVEAL phase, in ms. */
  REVEAL_PHASE_MS: 10_000,
  /** Committed orders that never reveal by the reveal deadline forfeit their deposit. */
  FORFEIT_ON_MISSED_REVEAL: true,
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

/* ------------------------------------------------------------------ */
/*  Session-key multi-sig emergency rotation (#375)                   */
/* ------------------------------------------------------------------ */

/** Lifecycle of a delegated session key in `session_key_registry`. */
export type SessionKeyStatus = "ACTIVE" | "ROTATING" | "REVOKED";

/** Row shape of `session_key_rotation_proposals` (2-of-3 admin threshold). */
export interface SessionKeyRotationProposal {
  proposalId: string;
  oldPubkey: string;
  newPubkey: string;
  signaturesCollected: number;
  requiredSignatures: number;
  signer1: string;
  signer2: string | null;
  executed: boolean;
  createdAt?: string;
  executedAt?: string | null;
}

/** Redis stream the API enqueues accepted rotation proposals onto. */
export const SESSION_ROTATION_QUEUE = "velo:session-rotation-queue";
/** Dead-letter stream for proposals that exhausted every confirmation retry. */
export const SESSION_ROTATION_DLQ = "velo:session-rotation-dlq";
/** Consumer group the rotation worker reads the queue with. */
export const SESSION_ROTATION_GROUP = "rotation-group";

/* ------------------------------------------------------------------ */
/*  Enterprise Multi-Tenant RBAC/ABAC & KMS (#401)                     */
/* ------------------------------------------------------------------ */
export * from "./types/enterprise.js";

/* ------------------------------------------------------------------ */
/*  Bidirectional State Channels & Off-Chain Micropayment Streaming   */
/* ------------------------------------------------------------------ */

/** Status of a state channel lifecycle. */
export type ChannelStatus = "OPEN" | "CLOSING" | "CLOSED" | "DISPUTED";

/** Metadata for a bidirectional state channel between two parties. */
export interface StateChannel {
  channelId: string;
  partyA: string;
  partyB: string;
  totalDepositStroops: bigint;
  nonce: bigint;
  status: ChannelStatus;
  createdAt: string;
  updatedAt: string;
}

/** Off-chain state commit with vector clock ordering and signature. */
export interface StateChannelCommit {
  commitId: string;
  channelId: string;
  sequenceNumber: bigint;
  signer: string;
  stateRoot: string;
  signature: string;
  partyABalance: bigint;
  partyBBalance: bigint;
  createdAt: string;
}

/** On-chain settlement submission tracking. */
export interface StateChannelSettlement {
  settlementId: string;
  channelId: string;
  finalSequenceNumber: bigint;
  initiator: string;
  partyAFinalBalance: bigint;
  partyBFinalBalance: bigint;
  merkleRoot: string;
  submittedTxnHash?: string | null;
  status: string;
  settledAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Dispute evidence and challenge record for penalty enforcement. */
export interface StateChannelAuditLog {
  auditId: string;
  channelId: string;
  eventType: string;
  challenger: string;
  challengedSequence: bigint;
  evidenceRoot?: string | null;
  penaltyAmount?: bigint | null;
  status: string;
  createdAt: string;
  resolvedAt?: string | null;
}

/** WebSocket message types for state channel state updates. */
export type StateChannelMessageType =
  | "sign_request"
  | "sign_response"
  | "settlement_ready"
  | "settlement_confirmed"
  | "dispute_challenge";

/** Signed off-chain state update sent over WebSocket. */
export interface StateChannelUpdate {
  messageType: StateChannelMessageType;
  channelId: string;
  sequenceNumber: bigint;
  partyABalance: bigint;
  partyBBalance: bigint;
  signer: string;
  signature: string;
  timestamp: number;
}

/** State channel configuration constants. */
export const STATE_CHANNELS = {
  /** Maximum number of off-chain transactions per second per channel. */
  MAX_TPS: 500,
  /** Redis stream for state channel updates. */
  UPDATE_STREAM: "velo:state-channels:updates",
  /** Consumer group for state channel workers. */
  WORKER_GROUP: "state-channels-group",
  /** Penalty slashing window (ms) for uncooperative close. */
  DISPUTE_WINDOW_MS: 86400000, // 24 hours
  /** Minimum signatures required to settle (2-of-2 cooperative). */
  SETTLEMENT_THRESHOLD: 2,
} as const;

/* ------------------------------------------------------------------ */
/*  ZK Range-Proof Attestation & Credential Issuance (#XXX)           */
/* ------------------------------------------------------------------ */

export type {
  PedersenCommitment,
  ZkRangeProofRequest,
  ZkRangeProof,
  ZkAttestation,
  ZkVerificationResponse,
  WasmRangeProofRequest,
  WasmRangeProofResponse,
  CredentialWalletState,
} from "./types/zk-range.js";

export { RANGE_PROOF_PARAMS, ATTRIBUTE_RANGES } from "./types/zk-range.js";

/* ------------------------------------------------------------------ */
/*  Automated Liquidity Reserve Rebalancing & Cross-Asset Yield       */
/*  Aggregation Vault (#408)                                          */
/* ------------------------------------------------------------------ */

export type {
  YieldVaultConfig,
  ProviderVaultShare,
  ApySample,
  HarvestResult,
  StrategyPosition,
  BufferDecision,
  LiquidityDrawPlan,
} from "./types/yield.js";

export { YIELD_VAULT } from "./types/yield.js";
