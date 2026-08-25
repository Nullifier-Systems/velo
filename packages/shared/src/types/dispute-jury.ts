/**
 * Types for the Decentralized Jury Dispute Arbitration & Escrow
 * Staking/Slashing Protocol (#404).
 *
 * Five VRF-selected jurors review encrypted evidence, cast commit-reveal
 * votes, and execute automated escrow resolution with stake slashing for
 * dishonest jurors.
 */

export type JurorPanelStatus = "VOTING" | "REVEALING" | "RESOLVED" | "SLASHED";

export type JurorVoteChoice = "BUYER" | "SELLER" | "ABSTAIN";

export interface JurorStake {
  jurorAddress: string;
  stakedAmountStroops: string;
  reputationScore: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface DisputePanel {
  panelId: string;
  tradeId: string;
  jurorAddresses: string[];
  status: JurorPanelStatus;
  escrowAmountStroops: string;
  resolution?: JurorVoteChoice;
  buyerShareBps?: number;
  createdAt: string;
  resolvedAt?: string;
}

export interface JuryVoteCommit {
  panelId: string;
  jurorAddress: string;
  commitHash: string;
}

export interface JuryVoteReveal {
  panelId: string;
  jurorAddress: string;
  vote: JurorVoteChoice;
  saltHex: string;
}

export interface JuryVoteRecord {
  id: string;
  panelId: string;
  jurorAddress: string;
  commitHash: string;
  revealedVote?: JurorVoteChoice;
  votePayload?: string;
  saltHex?: string;
  submittedAt: string;
  revealedAt?: string;
}

export interface JuryResolutionResult {
  panelId: string;
  resolution: JurorVoteChoice;
  buyerShareBps: number;
  voteBreakdown: Record<JurorVoteChoice, number>;
  slashedJurors: string[];
}

export const DISPUTE_JURY = {
  /** Number of jurors selected per dispute panel. */
  PANEL_SIZE: 5,
  /** Minimum stake required to serve as a juror (stroops). */
  MIN_STAKE_STROOPS: 100_000_000, // 10 USDC
  /** Maximum duration of the COMMIT phase (ms). */
  COMMIT_PHASE_MS: 30_000,
  /** Maximum duration of the REVEAL phase (ms). */
  REVEAL_PHASE_MS: 30_000,
  /** Slashing percentage for jurors who fail to reveal (basis points of 10000). */
  SLASH_BPS_ON_NO_REVEAL: 10_000, // 100%
  /** Slashing percentage for jurors voting with minority (basis points of 10000). */
  SLASH_BPS_ON_MINORITY: 5_000, // 50%
  /** Minimum reputation score to serve as a juror. */
  MIN_REPUTATION_SCORE: 50,
} as const;
