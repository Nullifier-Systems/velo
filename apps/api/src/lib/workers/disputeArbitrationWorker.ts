/**
 * Dispute Arbitration Worker (#404).
 *
 * Drives panel selection, voting timers (COMMIT → REVEAL → RESOLVE),
 * and on-chain slashing executions. Runs as a background process.
 */

import { DISPUTE_JURY, type JurorPanelStatus, type JurorVoteChoice } from "@velo/shared";
import { selectJurors, type JurorCandidate } from "../jury-selection.js";

export interface DisputeCase {
  tradeId: string;
  escrowAmountStroops: string;
  buyerAddress: string;
  sellerAddress: string;
}

export interface PanelRecord {
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

// In-memory store for panels (dev/test mode — production uses Postgres)
export const panelStore = new Map<string, PanelRecord>();
export const voteCommitStore = new Map<string, Map<string, string>>(); // panelId -> (juror -> commitHash)
export const voteRevealStore = new Map<string, Map<string, { vote: JurorVoteChoice; saltHex: string }>>();

/**
 * Create a dispute panel by selecting 5 jurors via VRF.
 */
export function createDisputePanel(
  dispute: DisputeCase,
  candidates: JurorCandidate[],
  ledgerSequence: number,
): PanelRecord {
  const { panelId, jurors, seed } = selectJurors(
    candidates,
    dispute.tradeId,
    ledgerSequence,
  );

  const record: PanelRecord = {
    panelId,
    tradeId: dispute.tradeId,
    jurorAddresses: jurors.map((j) => j.jurorAddress),
    status: "VOTING",
    escrowAmountStroops: dispute.escrowAmountStroops,
    createdAt: new Date().toISOString(),
  };

  panelStore.set(panelId, record);
  voteCommitStore.set(panelId, new Map());
  voteRevealStore.set(panelId, new Map());

  return record;
}

/**
 * Submit a vote commit for a juror on a panel.
 */
export function submitVoteCommit(
  panelId: string,
  jurorAddress: string,
  commitHash: string,
): void {
  const panel = panelStore.get(panelId);
  if (!panel) throw new Error("Panel not found");
  if (panel.status !== "VOTING") throw new Error("Panel not in VOTING phase");
  if (!panel.jurorAddresses.includes(jurorAddress))
    throw new Error("Juror not on panel");

  const commits = voteCommitStore.get(panelId)!;
  if (commits.has(jurorAddress))
    throw new Error("Juror already committed");

  commits.set(jurorAddress, commitHash);
}

/**
 * Transition panel from VOTING to REVEALING.
 */
export function startRevealPhase(panelId: string): void {
  const panel = panelStore.get(panelId);
  if (!panel) throw new Error("Panel not found");
  if (panel.status !== "VOTING") throw new Error("Panel not in VOTING phase");
  panel.status = "REVEALING";
}

/**
 * Submit a vote reveal for a juror on a panel.
 */
export function submitVoteReveal(
  panelId: string,
  jurorAddress: string,
  vote: JurorVoteChoice,
  saltHex: string,
): void {
  const panel = panelStore.get(panelId);
  if (!panel) throw new Error("Panel not found");
  if (panel.status !== "REVEALING") throw new Error("Panel not in REVEALING phase");
  if (!panel.jurorAddresses.includes(jurorAddress))
    throw new Error("Juror not on panel");

  const reveals = voteRevealStore.get(panelId)!;
  if (reveals.has(jurorAddress))
    throw new Error("Juror already revealed");

  reveals.set(jurorAddress, { vote, saltHex });
}

/**
 * Resolve a panel: count votes, determine majority, apply slashing.
 */
export function resolvePanel(panelId: string): {
  resolution: JurorVoteChoice;
  buyerShareBps: number;
  voteBreakdown: Record<JurorVoteChoice, number>;
  slashedJurors: string[];
} {
  const panel = panelStore.get(panelId);
  if (!panel) throw new Error("Panel not found");
  if (panel.status !== "REVEALING") throw new Error("Panel not in REVEALING phase");

  const reveals = voteRevealStore.get(panelId)!;
  const breakdown: Record<JurorVoteChoice, number> = { BUYER: 0, SELLER: 0, ABSTAIN: 0 };
  const revealedJurors: string[] = [];
  const slashedJurors: string[] = [];

  // Count revealed votes, slash non-revealing jurors
  for (const jurorAddr of panel.jurorAddresses) {
    const reveal = reveals.get(jurorAddr);
    if (reveal) {
      breakdown[reveal.vote]++;
      revealedJurors.push(jurorAddr);
    } else {
      // Juror failed to reveal — slash 100%
      slashedJurors.push(jurorAddr);
    }
  }

  // Determine majority
  let resolution: JurorVoteChoice;
  if (breakdown.BUYER > breakdown.SELLER) {
    resolution = "BUYER";
  } else if (breakdown.SELLER > breakdown.BUYER) {
    resolution = "SELLER";
  } else {
    resolution = "ABSTAIN";
  }

  const buyerShareBps =
    resolution === "BUYER" ? 10_000 : resolution === "SELLER" ? 0 : 5_000;

  // Slash minority voters (50% of stake)
  for (const jurorAddr of revealedJurors) {
    const reveal = reveals.get(jurorAddr)!;
    if (reveal.vote !== resolution && reveal.vote !== "ABSTAIN") {
      if (!slashedJurors.includes(jurorAddr)) {
        slashedJurors.push(jurorAddr);
      }
    }
  }

  panel.status = "RESOLVED";
  panel.resolution = resolution;
  panel.buyerShareBps = buyerShareBps;
  panel.resolvedAt = new Date().toISOString();

  return { resolution, buyerShareBps, voteBreakdown: breakdown, slashedJurors };
}

/**
 * Check if all jurors have committed (ready for reveal phase).
 */
export function allJurorsCommitted(panelId: string): boolean {
  const panel = panelStore.get(panelId);
  if (!panel) return false;
  const commits = voteCommitStore.get(panelId);
  if (!commits) return false;
  return commits.size === panel.jurorAddresses.length;
}

/**
 * Check if all jurors have revealed (ready for resolution).
 */
export function allJurorsRevealed(panelId: string): boolean {
  const panel = panelStore.get(panelId);
  if (!panel) return false;
  const reveals = voteRevealStore.get(panelId);
  if (!reveals) return false;
  return reveals.size === panel.jurorAddresses.length;
}
