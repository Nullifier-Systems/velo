/**
 * Cross-Ledger Settlement Time-Lock Atomic Swap Dispute Bridge — store.
 *
 * Backs `atomic_swap_dispute_bridges` (migration 029). Two callers act on the
 * same swap concurrently: `swapDisputeWorker` scanning for expiries and
 * revealed preimages, and an operator hitting
 * POST /api/v1/swaps/dispute-claim. Both must be able to run at once without
 * ever submitting two refunds for one swap.
 *
 * The concurrency model mirrors `multisigEscrowStore`: take
 * `SELECT ... FOR UPDATE` on the bridge row, then transition state CAS-style
 * (`UPDATE ... WHERE state = $expected`). Only the caller whose UPDATE
 * actually matched a row owns the follow-on on-chain submission — everyone
 * else is told the work is already claimed and does nothing. Slow I/O (the
 * Soroban call) happens *outside* the lock, so a stuck RPC cannot pin a
 * database row.
 *
 * Without a pool the store falls back to an in-memory map, so unit and
 * concurrency tests run with no database. Node runs this on a single thread,
 * so an in-memory critical section that never awaits is atomic by
 * construction — the fallback preserves the same exactly-once guarantee the
 * SQL path gets from row locks.
 */
import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";

export type SwapDisputeState =
  | "ACTIVE"
  | "SECRET_EXTRACTED"
  | "REFUND_CLAIMABLE"
  | "RESOLVED";

export interface SwapDisputeBridge {
  swapId: string;
  initiatorAddress: string;
  counterpartyAddress: string;
  secretHash: string;
  secretPreimage: string | null;
  expirationLedger: number;
  state: SwapDisputeState;
}

export interface RegisterSwapInput {
  swapId: string;
  initiatorAddress: string;
  counterpartyAddress: string;
  secretHash: string;
  expirationLedger: number;
}

export interface RecordSecretResult {
  bridge: SwapDisputeBridge;
  /**
   * True exactly once, for the caller whose observation first moved the swap
   * to SECRET_EXTRACTED. That caller owns claiming the counterpart leg.
   */
  claimedForSettlement: boolean;
}

export interface ClaimRefundResult {
  bridge: SwapDisputeBridge;
  /**
   * True exactly once, for the single caller that moved the swap to
   * REFUND_CLAIMABLE. Only that caller may submit refund() on-chain.
   */
  claimedForRefund: boolean;
  /** Why a claim was refused, when `claimedForRefund` is false. */
  reason: "claimed" | "not_expired" | "secret_already_extracted" | "resolved" | null;
}

interface BridgeRow {
  swap_id: string;
  initiator_address: string;
  counterparty_address: string;
  secret_hash: string;
  secret_preimage: string | null;
  expiration_ledger: number;
  state: SwapDisputeState;
}

export class SwapDisputeNotFoundError extends Error {
  constructor(swapId: string) {
    super(`Atomic swap dispute bridge not found: ${swapId}`);
    this.name = "SwapDisputeNotFoundError";
  }
}

export class InvalidPreimageError extends Error {
  constructor(swapId: string) {
    super(`Preimage does not hash to the swap's secret_hash: ${swapId}`);
    this.name = "InvalidPreimageError";
  }
}

function rowToBridge(row: BridgeRow): SwapDisputeBridge {
  return {
    swapId: row.swap_id,
    initiatorAddress: row.initiator_address,
    counterpartyAddress: row.counterparty_address,
    secretHash: row.secret_hash,
    secretPreimage: row.secret_preimage,
    expirationLedger: Number(row.expiration_ledger),
    state: row.state,
  };
}

const SELECT_COLUMNS = `swap_id, initiator_address, counterparty_address,
                        secret_hash, secret_preimage, expiration_ledger, state`;

/**
 * Verifies a preimage against the swap's secret hash.
 *
 * The Stellar leg hashes with SHA-256 (`env.crypto().sha256` in
 * contracts/atomic-swap), so the check here must be SHA-256 too. Both sides
 * are hex; comparison is case-insensitive because chains differ on casing.
 */
export function preimageMatchesHash(preimageHex: string, secretHashHex: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(preimageHex)) return false;
  const digest = createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex");
  return digest.toLowerCase() === secretHashHex.toLowerCase();
}

export class SwapDisputeStore {
  private readonly pool: Pool | null;
  private readonly memory = new Map<string, SwapDisputeBridge>();

  constructor(pool: Pool | null = null) {
    this.pool = pool;
  }

  /** Registers a swap for monitoring. Idempotent — re-registering is a no-op. */
  async registerSwap(input: RegisterSwapInput): Promise<SwapDisputeBridge> {
    if (!this.pool) {
      const existing = this.memory.get(input.swapId);
      if (existing) return { ...existing };
      const bridge: SwapDisputeBridge = {
        swapId: input.swapId,
        initiatorAddress: input.initiatorAddress,
        counterpartyAddress: input.counterpartyAddress,
        secretHash: input.secretHash,
        secretPreimage: null,
        expirationLedger: input.expirationLedger,
        state: "ACTIVE",
      };
      this.memory.set(input.swapId, bridge);
      return { ...bridge };
    }

    const { rows } = await this.pool.query<BridgeRow>(
      `INSERT INTO atomic_swap_dispute_bridges
         (swap_id, initiator_address, counterparty_address, secret_hash, expiration_ledger)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (swap_id) DO UPDATE SET swap_id = EXCLUDED.swap_id
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.swapId,
        input.initiatorAddress,
        input.counterpartyAddress,
        input.secretHash,
        input.expirationLedger,
      ],
    );
    return rowToBridge(rows[0]);
  }

  async getBridge(swapId: string): Promise<SwapDisputeBridge | null> {
    if (!this.pool) {
      const bridge = this.memory.get(swapId);
      return bridge ? { ...bridge } : null;
    }
    const { rows } = await this.pool.query<BridgeRow>(
      `SELECT ${SELECT_COLUMNS} FROM atomic_swap_dispute_bridges WHERE swap_id = $1`,
      [swapId],
    );
    return rows[0] ? rowToBridge(rows[0]) : null;
  }

  /**
   * Swaps whose timeout has passed and which are still ACTIVE — the worker's
   * candidate set for automated refund claims.
   */
  async listExpiredActive(currentLedger: number, limit = 100): Promise<SwapDisputeBridge[]> {
    if (!this.pool) {
      return [...this.memory.values()]
        .filter((b) => b.state === "ACTIVE" && currentLedger >= b.expirationLedger)
        .slice(0, limit)
        .map((b) => ({ ...b }));
    }
    const { rows } = await this.pool.query<BridgeRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM atomic_swap_dispute_bridges
        WHERE state = 'ACTIVE' AND expiration_ledger <= $1
        ORDER BY expiration_ledger ASC
        LIMIT $2`,
      [currentLedger, limit],
    );
    return rows.map(rowToBridge);
  }

  /**
   * Durably records a preimage observed on either leg.
   *
   * This is the answer to relayer secret leakage: the preimage stops being
   * event-log-only the moment it is seen. Write-once — a swap that already
   * has a stored preimage keeps the first one, so a later (or malicious)
   * caller cannot overwrite it.
   *
   * Rejects a preimage that does not hash to `secret_hash`, so a bad
   * observation can never poison the record.
   */
  async recordSecret(swapId: string, preimageHex: string): Promise<RecordSecretResult> {
    if (!this.pool) return this.recordSecretInMemory(swapId, preimageHex);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.recordSecretLocked(client, swapId, preimageHex);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordSecretLocked(
    client: Pick<PoolClient, "query">,
    swapId: string,
    preimageHex: string,
  ): Promise<RecordSecretResult> {
    const { rows } = await client.query<BridgeRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM atomic_swap_dispute_bridges WHERE swap_id = $1 FOR UPDATE`,
      [swapId],
    );
    if (!rows[0]) throw new SwapDisputeNotFoundError(swapId);
    const current = rowToBridge(rows[0]);

    if (!preimageMatchesHash(preimageHex, current.secretHash)) {
      throw new InvalidPreimageError(swapId);
    }

    // Write-once: only an ACTIVE swap with no stored preimage transitions.
    const { rows: updated } = await client.query<BridgeRow>(
      `UPDATE atomic_swap_dispute_bridges
          SET secret_preimage = $2, state = 'SECRET_EXTRACTED'
        WHERE swap_id = $1 AND secret_preimage IS NULL AND state = 'ACTIVE'
        RETURNING ${SELECT_COLUMNS}`,
      [swapId, preimageHex],
    );

    if (!updated[0]) {
      return { bridge: current, claimedForSettlement: false };
    }
    return { bridge: rowToBridge(updated[0]), claimedForSettlement: true };
  }

  private recordSecretInMemory(swapId: string, preimageHex: string): RecordSecretResult {
    const bridge = this.memory.get(swapId);
    if (!bridge) throw new SwapDisputeNotFoundError(swapId);
    if (!preimageMatchesHash(preimageHex, bridge.secretHash)) {
      throw new InvalidPreimageError(swapId);
    }

    if (bridge.secretPreimage !== null || bridge.state !== "ACTIVE") {
      return { bridge: { ...bridge }, claimedForSettlement: false };
    }

    bridge.secretPreimage = preimageHex;
    bridge.state = "SECRET_EXTRACTED";
    return { bridge: { ...bridge }, claimedForSettlement: true };
  }

  /**
   * Claims the right to submit an on-chain refund for an expired swap.
   *
   * Returns `claimedForRefund: true` for exactly one caller. Everyone else
   * gets `false` plus the reason, and must not submit. A swap whose secret
   * was extracted is never refundable — it settles instead, and refunding it
   * would hand the funds back while the counterparty still holds a usable
   * preimage.
   */
  async claimRefund(swapId: string, currentLedger: number): Promise<ClaimRefundResult> {
    if (!this.pool) return this.claimRefundInMemory(swapId, currentLedger);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.claimRefundLocked(client, swapId, currentLedger);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async claimRefundLocked(
    client: Pick<PoolClient, "query">,
    swapId: string,
    currentLedger: number,
  ): Promise<ClaimRefundResult> {
    const { rows } = await client.query<BridgeRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM atomic_swap_dispute_bridges WHERE swap_id = $1 FOR UPDATE`,
      [swapId],
    );
    if (!rows[0]) throw new SwapDisputeNotFoundError(swapId);
    const current = rowToBridge(rows[0]);

    const refusal = refusalReason(current, currentLedger);
    if (refusal) return { bridge: current, claimedForRefund: false, reason: refusal };

    const { rows: updated } = await client.query<BridgeRow>(
      `UPDATE atomic_swap_dispute_bridges
          SET state = 'REFUND_CLAIMABLE'
        WHERE swap_id = $1 AND state = 'ACTIVE'
        RETURNING ${SELECT_COLUMNS}`,
      [swapId],
    );

    if (!updated[0]) {
      return { bridge: current, claimedForRefund: false, reason: "claimed" };
    }
    return { bridge: rowToBridge(updated[0]), claimedForRefund: true, reason: null };
  }

  private claimRefundInMemory(swapId: string, currentLedger: number): ClaimRefundResult {
    const bridge = this.memory.get(swapId);
    if (!bridge) throw new SwapDisputeNotFoundError(swapId);

    const refusal = refusalReason(bridge, currentLedger);
    if (refusal) return { bridge: { ...bridge }, claimedForRefund: false, reason: refusal };

    bridge.state = "REFUND_CLAIMABLE";
    return { bridge: { ...bridge }, claimedForRefund: true, reason: null };
  }

  /** Marks a swap terminal once its refund or settlement has landed on-chain. */
  async markResolved(swapId: string): Promise<SwapDisputeBridge> {
    if (!this.pool) {
      const bridge = this.memory.get(swapId);
      if (!bridge) throw new SwapDisputeNotFoundError(swapId);
      bridge.state = "RESOLVED";
      return { ...bridge };
    }

    const { rows } = await this.pool.query<BridgeRow>(
      `UPDATE atomic_swap_dispute_bridges SET state = 'RESOLVED'
        WHERE swap_id = $1 RETURNING ${SELECT_COLUMNS}`,
      [swapId],
    );
    if (!rows[0]) throw new SwapDisputeNotFoundError(swapId);
    return rowToBridge(rows[0]);
  }
}

/**
 * Why a swap cannot be claimed for refund right now, or null if it can.
 * Shared by the SQL and in-memory paths so both refuse for the same reasons.
 */
function refusalReason(
  bridge: SwapDisputeBridge,
  currentLedger: number,
): ClaimRefundResult["reason"] {
  if (bridge.state === "RESOLVED") return "resolved";
  if (bridge.state === "SECRET_EXTRACTED") return "secret_already_extracted";
  if (bridge.state === "REFUND_CLAIMABLE") return "claimed";
  if (currentLedger < bridge.expirationLedger) return "not_expired";
  return null;
}
