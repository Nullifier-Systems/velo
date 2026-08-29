/**
 * Multi-Sig Escrow Threshold Release & Key Recovery Protocol (issue #433).
 *
 * Buyer, seller, and (optionally) a backup/arbitrator key sign the same
 * release payload off-chain, at their own pace — they are not online at
 * the same time. This store collects those signatures against one pinned
 * "release attempt" per trade (`multisig_escrow_releases`) so every
 * signer is guaranteed to be signing the exact same
 * `(trade_id, release_amount, recipient_address, nonce)` the contract
 * will verify (see `multisigReleasePayloadHash` in lib/stellar.ts).
 *
 * Concurrency: two signers approving at nearly the same moment must
 * trigger the on-chain `release_escrow` call exactly once. This is a
 * "claim, then do slow I/O outside the lock" pattern: `addApproval`
 * upserts under `SELECT ... FOR UPDATE` on the release row and, if
 * threshold is met, atomically flips `status` from `pending` to
 * `releasing` via `UPDATE ... WHERE status = 'pending'` — only the caller
 * whose UPDATE actually matched a row is allowed to submit on-chain
 * (tests/concurrency/multisig_release_stress.test.ts).
 */
import type { Pool, PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";

export interface MultisigRelease {
  tradeId: string;
  recipientAddress: string;
  releaseAmountStroops: string;
  nonce: string;
  threshold: number;
  status: "pending" | "releasing" | "released" | "failed";
  releaseTxHash: string | null;
}

export interface SignerApproval {
  approvalId: string;
  tradeId: string;
  signerAddress: string;
  signerPubkeyHex: string;
  signature: string;
}

export interface AddApprovalInput {
  tradeId: string;
  signerAddress: string;
  signerPubkeyHex: string;
  signature: string;
}

export interface AddApprovalResult {
  release: MultisigRelease;
  approvals: SignerApproval[];
  /** True exactly once, for the single caller that met threshold and may now submit on-chain. */
  claimedForSubmission: boolean;
}

interface ReleaseRow {
  trade_id: string;
  recipient_address: string;
  release_amount_stroops: string;
  nonce: string;
  threshold: number;
  status: MultisigRelease["status"];
  release_tx_hash: string | null;
}

interface ApprovalRow {
  approval_id: string;
  trade_id: string;
  signer_address: string;
  signer_pubkey_hex: string;
  signature: string;
}

function rowToRelease(row: ReleaseRow): MultisigRelease {
  return {
    tradeId: row.trade_id,
    recipientAddress: row.recipient_address,
    releaseAmountStroops: String(row.release_amount_stroops),
    nonce: String(row.nonce),
    threshold: Number(row.threshold),
    status: row.status,
    releaseTxHash: row.release_tx_hash,
  };
}

function rowToApproval(row: ApprovalRow): SignerApproval {
  return {
    approvalId: row.approval_id,
    tradeId: row.trade_id,
    signerAddress: row.signer_address,
    signerPubkeyHex: row.signer_pubkey_hex,
    signature: row.signature,
  };
}

/** Generates a nonce in the same space `release_escrow`'s `u64 nonce` accepts. */
function generateNonce(): string {
  // 8 random bytes fits comfortably under u64::MAX; top bit cleared so the
  // decimal string round-trips through JS `BigInt` / Postgres `BIGINT`
  // (signed 64-bit) without sign ambiguity.
  const bytes = randomBytes(8);
  bytes[0] &= 0x7f;
  return BigInt(`0x${bytes.toString("hex")}`).toString();
}

interface MemoryState {
  releases: Map<string, MultisigRelease>;
  approvals: Map<string, SignerApproval[]>;
}

/**
 * Store backing the `/cash/multisig-release/*` routes. Falls back to an
 * in-memory implementation with no Postgres pool configured, mirroring
 * `CollateralGuardStore` — same degrade-gracefully-in-dev shape.
 */
export class MultisigEscrowStore {
  private memory: MemoryState = { releases: new Map(), approvals: new Map() };

  constructor(private readonly pool?: Pick<Pool, "connect" | "query">) {}

  /**
   * Returns the trade's pending release attempt, creating one (with a
   * fresh nonce) if none exists yet. Idempotent per trade — every signer
   * ends up signing the same pinned payload.
   */
  async getOrCreateRelease(input: {
    tradeId: string;
    recipientAddress: string;
    releaseAmountStroops: string;
    threshold: number;
  }): Promise<MultisigRelease> {
    if (!this.pool) {
      const existing = this.memory.releases.get(input.tradeId);
      if (existing) return existing;
      const release: MultisigRelease = {
        tradeId: input.tradeId,
        recipientAddress: input.recipientAddress,
        releaseAmountStroops: input.releaseAmountStroops,
        nonce: generateNonce(),
        threshold: input.threshold,
        status: "pending",
        releaseTxHash: null,
      };
      this.memory.releases.set(input.tradeId, release);
      this.memory.approvals.set(input.tradeId, []);
      return release;
    }

    const { rows } = await this.pool.query<ReleaseRow>(
      `INSERT INTO multisig_escrow_releases
         (trade_id, recipient_address, release_amount_stroops, nonce, threshold)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (trade_id) DO UPDATE
         SET trade_id = EXCLUDED.trade_id
       RETURNING trade_id, recipient_address, release_amount_stroops, nonce,
                 threshold, status, release_tx_hash`,
      [input.tradeId, input.recipientAddress, input.releaseAmountStroops, generateNonce(), input.threshold],
    );
    return rowToRelease(rows[0]);
  }

  async getRelease(tradeId: string): Promise<MultisigRelease | null> {
    if (!this.pool) return this.memory.releases.get(tradeId) ?? null;
    const { rows } = await this.pool.query<ReleaseRow>(
      `SELECT trade_id, recipient_address, release_amount_stroops, nonce,
              threshold, status, release_tx_hash
         FROM multisig_escrow_releases WHERE trade_id = $1`,
      [tradeId],
    );
    return rows[0] ? rowToRelease(rows[0]) : null;
  }

  async listApprovals(tradeId: string): Promise<SignerApproval[]> {
    if (!this.pool) return [...(this.memory.approvals.get(tradeId) ?? [])];
    const { rows } = await this.pool.query<ApprovalRow>(
      `SELECT approval_id, trade_id, signer_address, signer_pubkey_hex, signature
         FROM multisig_escrow_approvals WHERE trade_id = $1`,
      [tradeId],
    );
    return rows.map(rowToApproval);
  }

  /**
   * Records one signer's approval and, if it just met threshold, claims
   * the release for on-chain submission (`status: pending -> releasing`)
   * so exactly one caller proceeds to call `submitThresholdRelease`.
   *
   * The caller must have already verified `signature` against
   * `signerPubkeyHex` (see `verifyTradeSignerSignature`) — this store
   * only enforces "one approval per (trade, signer)", not cryptographic
   * validity.
   */
  async addApproval(input: AddApprovalInput): Promise<AddApprovalResult> {
    if (!this.pool) return this.addApprovalInMemory(input);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.addApprovalLocked(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async addApprovalLocked(
    client: Pick<PoolClient, "query">,
    input: AddApprovalInput,
  ): Promise<AddApprovalResult> {
    const { rows: releaseRows } = await client.query<ReleaseRow>(
      `SELECT trade_id, recipient_address, release_amount_stroops, nonce,
              threshold, status, release_tx_hash
         FROM multisig_escrow_releases WHERE trade_id = $1 FOR UPDATE`,
      [input.tradeId],
    );
    if (!releaseRows[0]) {
      throw new MultisigReleaseNotFoundError(input.tradeId);
    }
    let release = rowToRelease(releaseRows[0]);

    await client.query(
      `INSERT INTO multisig_escrow_approvals
         (trade_id, signer_address, signer_pubkey_hex, signature)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (trade_id, signer_address) DO NOTHING`,
      [input.tradeId, input.signerAddress, input.signerPubkeyHex, input.signature],
    );

    const { rows: approvalRows } = await client.query<ApprovalRow>(
      `SELECT approval_id, trade_id, signer_address, signer_pubkey_hex, signature
         FROM multisig_escrow_approvals WHERE trade_id = $1`,
      [input.tradeId],
    );
    const approvals = approvalRows.map(rowToApproval);

    let claimedForSubmission = false;
    if (release.status === "pending" && approvals.length >= release.threshold) {
      const { rowCount } = await client.query(
        `UPDATE multisig_escrow_releases
            SET status = 'releasing'
          WHERE trade_id = $1 AND status = 'pending'`,
        [input.tradeId],
      );
      claimedForSubmission = (rowCount ?? 0) > 0;
      if (claimedForSubmission) release = { ...release, status: "releasing" };
    }

    return { release, approvals, claimedForSubmission };
  }

  private addApprovalInMemory(input: AddApprovalInput): AddApprovalResult {
    const release = this.memory.releases.get(input.tradeId);
    if (!release) throw new MultisigReleaseNotFoundError(input.tradeId);

    const list = this.memory.approvals.get(input.tradeId) ?? [];
    if (!list.some((a) => a.signerAddress === input.signerAddress)) {
      list.push({
        approvalId: randomUUID(),
        tradeId: input.tradeId,
        signerAddress: input.signerAddress,
        signerPubkeyHex: input.signerPubkeyHex,
        signature: input.signature,
      });
      this.memory.approvals.set(input.tradeId, list);
    }

    let claimedForSubmission = false;
    if (release.status === "pending" && list.length >= release.threshold) {
      release.status = "releasing";
      claimedForSubmission = true;
    }

    return { release: { ...release }, approvals: [...list], claimedForSubmission };
  }

  /** Marks a claimed release as settled once the on-chain call confirms. */
  async markReleased(tradeId: string, txHash: string): Promise<void> {
    if (!this.pool) {
      const release = this.memory.releases.get(tradeId);
      if (release) {
        release.status = "released";
        release.releaseTxHash = txHash;
      }
      return;
    }
    await this.pool.query(
      `UPDATE multisig_escrow_releases
          SET status = 'released', release_tx_hash = $2, released_at = CURRENT_TIMESTAMP
        WHERE trade_id = $1 AND status = 'releasing'`,
      [tradeId, txHash],
    );
  }

  /** Reverts a claimed release back to `pending` so it can be retried after an on-chain failure. */
  async markFailed(tradeId: string): Promise<void> {
    if (!this.pool) {
      const release = this.memory.releases.get(tradeId);
      if (release) release.status = "pending";
      return;
    }
    await this.pool.query(
      `UPDATE multisig_escrow_releases
          SET status = 'pending'
        WHERE trade_id = $1 AND status = 'releasing'`,
      [tradeId],
    );
  }
}

export class MultisigReleaseNotFoundError extends Error {
  constructor(readonly tradeId: string) {
    super(`No multisig release attempt registered for trade ${tradeId}`);
    this.name = "MultisigReleaseNotFoundError";
  }
}
