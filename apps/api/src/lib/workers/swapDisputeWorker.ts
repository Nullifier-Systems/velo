import crypto from "node:crypto";
import type { Pool } from "pg";
import {
  sendSwapDisputeAlert,
  sendSwapSecretExtractedAlert,
  sendSwapDisputeRefundAlert,
} from "../webhook.js";

export type SwapDisputeState =
  | "ACTIVE"
  | "SECRET_EXTRACTED"
  | "REFUND_CLAIMABLE"
  | "RESOLVED";

export interface AtomicSwapDisputeBridgeRecord {
  swapId: string;
  initiatorAddress: string;
  counterpartyAddress: string;
  secretHash: string;
  secretPreimage?: string | null;
  expirationLedger: number;
  state: SwapDisputeState;
  executionProof?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterBridgeParams {
  swapId: string;
  initiatorAddress: string;
  counterpartyAddress: string;
  secretHash: string;
  expirationLedger: number;
}

export interface ClaimDisputeRefundResult {
  success: boolean;
  swapId: string;
  state: SwapDisputeState;
  action: "REFUNDED_TIMEOUT" | "RESOLVED_SECRET" | "ALREADY_RESOLVED";
  executionProof?: string;
  secretPreimage?: string | null;
}

/** In-memory store fallback when Postgres pool is not attached */
export const memorySwapDisputeStore = new Map<string, AtomicSwapDisputeBridgeRecord>();

export class SwapDisputeStore {
  private pool?: Pool;
  private locks = new Map<string, Promise<void>>();

  constructor(pool?: Pool) {
    this.pool = pool;
  }

  private async acquireLock(key: string): Promise<() => void> {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.locks.set(key, lockPromise);

    return () => {
      this.locks.delete(key);
      resolveLock();
    };
  }

  async registerBridge(params: RegisterBridgeParams): Promise<AtomicSwapDisputeBridgeRecord> {
    const unlock = await this.acquireLock(params.swapId);
    try {
      if (this.pool) {
        const query = `
          INSERT INTO atomic_swap_dispute_bridges
            (swap_id, initiator_address, counterparty_address, secret_hash, expiration_ledger, state)
          VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
          ON CONFLICT (swap_id) DO UPDATE
            SET initiator_address = EXCLUDED.initiator_address,
                counterparty_address = EXCLUDED.counterparty_address,
                secret_hash = EXCLUDED.secret_hash,
                expiration_ledger = EXCLUDED.expiration_ledger,
                updated_at = NOW()
          RETURNING *;
        `;
        const res = await this.pool.query(query, [
          params.swapId,
          params.initiatorAddress,
          params.counterpartyAddress,
          params.secretHash,
          params.expirationLedger,
        ]);
        const row = res.rows[0];
        const record: AtomicSwapDisputeBridgeRecord = {
          swapId: row.swap_id,
          initiatorAddress: row.initiator_address,
          counterpartyAddress: row.counterparty_address,
          secretHash: row.secret_hash,
          secretPreimage: row.secret_preimage,
          expirationLedger: Number(row.expiration_ledger),
          state: row.state as SwapDisputeState,
          executionProof: row.execution_proof,
          resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
        };
        await sendSwapDisputeAlert({
          swapId: record.swapId,
          state: record.state,
          initiatorAddress: record.initiatorAddress,
          counterpartyAddress: record.counterpartyAddress,
          reason: "Registered on dispute bridge",
        });
        return record;
      }

      const now = new Date().toISOString();
      const existing = memorySwapDisputeStore.get(params.swapId);
      const record: AtomicSwapDisputeBridgeRecord = {
        swapId: params.swapId,
        initiatorAddress: params.initiatorAddress,
        counterpartyAddress: params.counterpartyAddress,
        secretHash: params.secretHash,
        secretPreimage: existing?.secretPreimage || null,
        expirationLedger: params.expirationLedger,
        state: existing?.state || "ACTIVE",
        executionProof: existing?.executionProof || null,
        resolvedAt: existing?.resolvedAt || null,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      memorySwapDisputeStore.set(params.swapId, record);
      await sendSwapDisputeAlert({
        swapId: record.swapId,
        state: record.state,
        initiatorAddress: record.initiatorAddress,
        counterpartyAddress: record.counterpartyAddress,
        reason: "Registered on dispute bridge",
      });
      return record;
    } finally {
      unlock();
    }
  }

  async getBridge(swapId: string): Promise<AtomicSwapDisputeBridgeRecord | null> {
    if (this.pool) {
      const res = await this.pool.query(
        "SELECT * FROM atomic_swap_dispute_bridges WHERE swap_id = $1",
        [swapId],
      );
      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      return {
        swapId: row.swap_id,
        initiatorAddress: row.initiator_address,
        counterpartyAddress: row.counterparty_address,
        secretHash: row.secret_hash,
        secretPreimage: row.secret_preimage,
        expirationLedger: Number(row.expiration_ledger),
        state: row.state as SwapDisputeState,
        executionProof: row.execution_proof,
        resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    }
    return memorySwapDisputeStore.get(swapId) || null;
  }

  /**
   * Dual-side secret extraction: when counterparty redeems on counterparty ledger,
   * extracts revealed preimage, verifies against secret_hash, and updates status.
   */
  async extractSecretPreimage(
    swapId: string,
    secretPreimage: string,
    chain: string,
    blockOrLedger?: number,
  ): Promise<{ updated: boolean; state: SwapDisputeState }> {
    const unlock = await this.acquireLock(swapId);
    try {
      const record = await this.getBridge(swapId);
      if (!record) {
        throw new Error(`Swap dispute bridge for swapId ${swapId} not found`);
      }

      if (record.state === "RESOLVED") {
        return { updated: false, state: record.state };
      }

      // Verify SHA-256(preimage) matches secretHash
      const cleanPreimage = secretPreimage.replace(/^0x/, "");
      const computedHash = crypto
        .createHash("sha256")
        .update(Buffer.from(cleanPreimage, "hex"))
        .digest("hex");

      const cleanSecretHash = record.secretHash.replace(/^0x/, "").toLowerCase();
      if (computedHash.toLowerCase() !== cleanSecretHash) {
        throw new Error("Cryptographic verification failed: preimage does not match secret_hash");
      }

      if (this.pool) {
        await this.pool.query(
          `UPDATE atomic_swap_dispute_bridges
           SET secret_preimage = $1, state = 'SECRET_EXTRACTED', updated_at = NOW()
           WHERE swap_id = $2`,
          [cleanPreimage, swapId],
        );
      } else {
        record.secretPreimage = cleanPreimage;
        record.state = "SECRET_EXTRACTED";
        record.updatedAt = new Date().toISOString();
        memorySwapDisputeStore.set(swapId, record);
      }

      await sendSwapSecretExtractedAlert({
        swapId,
        secret: cleanPreimage,
        chain,
        blockOrLedger,
      });

      return { updated: true, state: "SECRET_EXTRACTED" };
    } finally {
      unlock();
    }
  }

  /**
   * Executes atomic dispute refund or settlement resolution with pessimistic locking.
   */
  async claimDisputeRefundOrResolve(
    swapId: string,
    currentLedger: number,
  ): Promise<ClaimDisputeRefundResult> {
    const unlock = await this.acquireLock(swapId);
    try {
      if (this.pool) {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          const sel = await client.query(
            "SELECT * FROM atomic_swap_dispute_bridges WHERE swap_id = $1 FOR UPDATE",
            [swapId],
          );
          if (sel.rows.length === 0) {
            await client.query("ROLLBACK");
            throw new Error(`Swap ${swapId} not found`);
          }

          const row = sel.rows[0];
          const state = row.state as SwapDisputeState;
          if (state === "RESOLVED") {
            await client.query("COMMIT");
            return {
              success: true,
              swapId,
              state: "RESOLVED",
              action: "ALREADY_RESOLVED",
              executionProof: row.execution_proof,
              secretPreimage: row.secret_preimage,
            };
          }

          // Case 1: Secret was extracted -> complete swap on target chain
          if (row.secret_preimage) {
            const proof = `proof_secret_${swapId}_${Date.now()}`;
            await client.query(
              `UPDATE atomic_swap_dispute_bridges
               SET state = 'RESOLVED', execution_proof = $1, resolved_at = NOW(), updated_at = NOW()
               WHERE swap_id = $2`,
              [proof, swapId],
            );
            await client.query("COMMIT");
            return {
              success: true,
              swapId,
              state: "RESOLVED",
              action: "RESOLVED_SECRET",
              executionProof: proof,
              secretPreimage: row.secret_preimage,
            };
          }

          // Case 2: Expiration ledger reached -> trigger dispute timeout refund
          if (currentLedger >= Number(row.expiration_ledger)) {
            const proof = `proof_refund_${swapId}_ledger_${currentLedger}`;
            await client.query(
              `UPDATE atomic_swap_dispute_bridges
               SET state = 'RESOLVED', execution_proof = $1, resolved_at = NOW(), updated_at = NOW()
               WHERE swap_id = $2`,
              [proof, swapId],
            );
            await client.query("COMMIT");

            await sendSwapDisputeRefundAlert({
              swapId,
              recipient: row.initiator_address,
              expirationLedger: Number(row.expiration_ledger),
              currentLedger,
            });

            return {
              success: true,
              swapId,
              state: "RESOLVED",
              action: "REFUNDED_TIMEOUT",
              executionProof: proof,
              secretPreimage: null,
            };
          }

          // Not expired yet and no secret
          await client.query("ROLLBACK");
          throw new Error(
            `Cannot claim dispute refund: current ledger ${currentLedger} < expiration ledger ${row.expiration_ledger}`,
          );
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      }

      // In-memory mutex branch
      const record = memorySwapDisputeStore.get(swapId);
      if (!record) {
        throw new Error(`Swap ${swapId} not found`);
      }

      if (record.state === "RESOLVED") {
        return {
          success: true,
          swapId,
          state: "RESOLVED",
          action: "ALREADY_RESOLVED",
          executionProof: record.executionProof || undefined,
          secretPreimage: record.secretPreimage,
        };
      }

      if (record.secretPreimage) {
        const proof = `proof_secret_${swapId}_${Date.now()}`;
        record.state = "RESOLVED";
        record.executionProof = proof;
        record.resolvedAt = new Date().toISOString();
        record.updatedAt = new Date().toISOString();
        memorySwapDisputeStore.set(swapId, record);
        return {
          success: true,
          swapId,
          state: "RESOLVED",
          action: "RESOLVED_SECRET",
          executionProof: proof,
          secretPreimage: record.secretPreimage,
        };
      }

      if (currentLedger >= record.expirationLedger) {
        const proof = `proof_refund_${swapId}_ledger_${currentLedger}`;
        record.state = "RESOLVED";
        record.executionProof = proof;
        record.resolvedAt = new Date().toISOString();
        record.updatedAt = new Date().toISOString();
        memorySwapDisputeStore.set(swapId, record);

        await sendSwapDisputeRefundAlert({
          swapId,
          recipient: record.initiatorAddress,
          expirationLedger: record.expirationLedger,
          currentLedger,
        });

        return {
          success: true,
          swapId,
          state: "RESOLVED",
          action: "REFUNDED_TIMEOUT",
          executionProof: proof,
          secretPreimage: null,
        };
      }

      throw new Error(
        `Cannot claim dispute refund: current ledger ${currentLedger} < expiration ledger ${record.expirationLedger}`,
      );
    } finally {
      unlock();
    }
  }

  /** Sweep expired active swaps for automatic dispute resolution */
  async sweepExpiredSwaps(currentLedger: number): Promise<ClaimDisputeRefundResult[]> {
    const results: ClaimDisputeRefundResult[] = [];
    if (this.pool) {
      const res = await this.pool.query(
        `SELECT swap_id FROM atomic_swap_dispute_bridges
         WHERE state IN ('ACTIVE', 'REFUND_CLAIMABLE') AND expiration_ledger <= $1`,
        [currentLedger],
      );
      for (const row of res.rows) {
        try {
          const outcome = await this.claimDisputeRefundOrResolve(row.swap_id, currentLedger);
          results.push(outcome);
        } catch (err) {
          console.error(`Failed to auto-claim dispute refund for ${row.swap_id}:`, err);
        }
      }
      return results;
    }

    for (const record of memorySwapDisputeStore.values()) {
      if (
        (record.state === "ACTIVE" || record.state === "REFUND_CLAIMABLE") &&
        currentLedger >= record.expirationLedger
      ) {
        try {
          const outcome = await this.claimDisputeRefundOrResolve(record.swapId, currentLedger);
          results.push(outcome);
        } catch (err) {
          console.error(`Failed to auto-claim dispute refund for ${record.swapId}:`, err);
        }
      }
    }
    return results;
  }
}

/** Background worker interval for atomic swap dispute bridge monitoring */
export function startSwapDisputeWorker(params: {
  store: SwapDisputeStore;
  getCurrentLedger: () => Promise<number>;
  intervalMs?: number;
}): () => void {
  const { store, getCurrentLedger, intervalMs = 10_000 } = params;
  let running = true;

  const timer = setInterval(async () => {
    if (!running) return;
    try {
      const currentLedger = await getCurrentLedger();
      await store.sweepExpiredSwaps(currentLedger);
    } catch (err) {
      console.error("[SwapDisputeWorker] Error during sweep:", err);
    }
  }, intervalMs);

  return () => {
    running = false;
    clearInterval(timer);
  };
}
