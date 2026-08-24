import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { SessionKeyRotationProposal, SessionKeyStatus } from "@velo/shared";

/**
 * Registry of delegated session keys and their 2-of-3 rotation proposals (#375).
 *
 * The whole point of this store is that a spend and an emergency rotation can
 * never interleave: `reserveSpend` and `beginRotation` both run inside a
 * critical section keyed by the session pubkey. Postgres gets that from
 * `SELECT ... FOR UPDATE` inside one transaction; the in-memory implementation
 * reproduces the same serialization with a per-key promise chain.
 */

/** Threshold enforced by both the API and contracts/session-account. */
export const REQUIRED_ROTATION_SIGNATURES = 2;

export interface SessionKeyRecord {
  pubkey: string;
  status: SessionKeyStatus;
  spendingQuota: bigint;
  spentQuota: bigint;
}

export type ReserveSpendReason = "NOT_FOUND" | "NOT_ACTIVE" | "QUOTA_EXCEEDED";

export interface ReserveSpendResult {
  ok: boolean;
  reason?: ReserveSpendReason;
  status?: SessionKeyStatus;
  spentQuota?: bigint;
  /**
   * Ordinal of the critical section that served this call. Memory store only —
   * the Postgres path is serialized by `SELECT ... FOR UPDATE` instead. Used by
   * tests/concurrency/session_key_rotation_stress.test.ts to prove no spend
   * lands after the rotation lock without depending on wall-clock timing.
   */
  sequence?: number;
}

export interface RegisterKeyInput {
  pubkey: string;
  spendingQuota: bigint;
  status?: SessionKeyStatus;
}

export interface CreateProposalInput {
  oldPubkey: string;
  newPubkey: string;
  signer1: string;
}

/** Handle handed to the `beginRotation` callback while the row lock is held. */
export interface RotationLockContext {
  key: SessionKeyRecord;
  createProposal(input: CreateProposalInput): Promise<SessionKeyRotationProposal>;
}

export type BeginRotationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "NOT_FOUND" | "NOT_ACTIVE"; status?: SessionKeyStatus };

export interface SessionKeyRegistryStore {
  getKey(pubkey: string): Promise<SessionKeyRecord | null>;
  registerKey(input: RegisterKeyInput): Promise<SessionKeyRecord>;
  /** Atomically check ACTIVE + quota, then add to the spent counter. */
  reserveSpend(pubkey: string, amountStroops: bigint): Promise<ReserveSpendResult>;
  /** Lock the row, verify ACTIVE, flip it to ROTATING, run `cb`, commit. */
  beginRotation<T>(
    oldPubkey: string,
    cb: (ctx: RotationLockContext) => Promise<T>,
  ): Promise<BeginRotationOutcome<T>>;
  markRevoked(pubkey: string): Promise<void>;
  createProposal(input: CreateProposalInput): Promise<SessionKeyRotationProposal>;
  addSecondSignature(
    proposalId: string,
    signer2: string,
  ): Promise<SessionKeyRotationProposal | null>;
  getProposal(proposalId: string): Promise<SessionKeyRotationProposal | null>;
  markProposalExecuted(proposalId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Postgres                                                          */
/* ------------------------------------------------------------------ */

interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

const KEY_COLUMNS = "pubkey, status, spending_quota, spent_quota";
const PROPOSAL_COLUMNS =
  "proposal_id, old_pubkey, new_pubkey, signatures_collected, required_signatures, " +
  "signer_1, signer_2, executed, created_at, executed_at";

function rowToKey(row: any): SessionKeyRecord {
  return {
    pubkey: row.pubkey,
    status: row.status,
    spendingQuota: BigInt(row.spending_quota),
    spentQuota: BigInt(row.spent_quota),
  };
}

function rowToProposal(row: any): SessionKeyRotationProposal {
  return {
    proposalId: String(row.proposal_id),
    oldPubkey: row.old_pubkey,
    newPubkey: row.new_pubkey,
    signaturesCollected: Number(row.signatures_collected),
    requiredSignatures: Number(row.required_signatures),
    signer1: row.signer_1,
    signer2: row.signer_2 ?? null,
    executed: Boolean(row.executed),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    executedAt: row.executed_at ? new Date(row.executed_at).toISOString() : null,
  };
}

async function insertProposal(
  client: SqlClient,
  input: CreateProposalInput,
): Promise<SessionKeyRotationProposal> {
  const { rows } = await client.query(
    `INSERT INTO session_key_rotation_proposals
       (old_pubkey, new_pubkey, signatures_collected, required_signatures, signer_1)
     VALUES ($1, $2, 1, $3, $4)
     RETURNING ${PROPOSAL_COLUMNS}`,
    [input.oldPubkey, input.newPubkey, REQUIRED_ROTATION_SIGNATURES, input.signer1],
  );
  return rowToProposal(rows[0]);
}

export class PgSessionKeyRegistryStore implements SessionKeyRegistryStore {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  async getKey(pubkey: string): Promise<SessionKeyRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT ${KEY_COLUMNS} FROM session_key_registry WHERE pubkey = $1`,
      [pubkey],
    );
    return rows[0] ? rowToKey(rows[0]) : null;
  }

  async registerKey(input: RegisterKeyInput): Promise<SessionKeyRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO session_key_registry (pubkey, status, spending_quota)
       VALUES ($1, $2, $3)
       ON CONFLICT (pubkey) DO UPDATE SET
         status = EXCLUDED.status,
         spending_quota = EXCLUDED.spending_quota,
         updated_at = now()
       RETURNING ${KEY_COLUMNS}`,
      [input.pubkey, input.status ?? "ACTIVE", input.spendingQuota.toString()],
    );
    return rowToKey(rows[0]);
  }

  async reserveSpend(pubkey: string, amountStroops: bigint): Promise<ReserveSpendResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT ${KEY_COLUMNS} FROM session_key_registry WHERE pubkey = $1 FOR UPDATE`,
        [pubkey],
      );
      const key = rows[0] ? rowToKey(rows[0]) : null;
      if (!key) {
        await client.query("COMMIT");
        return { ok: false, reason: "NOT_FOUND" };
      }
      if (key.status !== "ACTIVE") {
        await client.query("COMMIT");
        return { ok: false, reason: "NOT_ACTIVE", status: key.status };
      }
      const nextSpent = key.spentQuota + amountStroops;
      if (nextSpent > key.spendingQuota) {
        await client.query("COMMIT");
        return { ok: false, reason: "QUOTA_EXCEEDED", status: key.status, spentQuota: key.spentQuota };
      }
      await client.query(
        `UPDATE session_key_registry
            SET spent_quota = $2, updated_at = now()
          WHERE pubkey = $1`,
        [pubkey, nextSpent.toString()],
      );
      await client.query("COMMIT");
      return { ok: true, status: key.status, spentQuota: nextSpent };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async beginRotation<T>(
    oldPubkey: string,
    cb: (ctx: RotationLockContext) => Promise<T>,
  ): Promise<BeginRotationOutcome<T>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT ${KEY_COLUMNS} FROM session_key_registry WHERE pubkey = $1 FOR UPDATE`,
        [oldPubkey],
      );
      const key = rows[0] ? rowToKey(rows[0]) : null;
      if (!key) {
        await client.query("COMMIT");
        return { ok: false, reason: "NOT_FOUND" };
      }
      if (key.status !== "ACTIVE") {
        await client.query("COMMIT");
        return { ok: false, reason: "NOT_ACTIVE", status: key.status };
      }
      await client.query(
        `UPDATE session_key_registry SET status = 'ROTATING', updated_at = now() WHERE pubkey = $1`,
        [oldPubkey],
      );
      const value = await cb({
        key: { ...key, status: "ROTATING" },
        createProposal: (input) => insertProposal(client, input),
      });
      await client.query("COMMIT");
      return { ok: true, value };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markRevoked(pubkey: string): Promise<void> {
    await this.pool.query(
      `UPDATE session_key_registry SET status = 'REVOKED', updated_at = now() WHERE pubkey = $1`,
      [pubkey],
    );
  }

  async createProposal(input: CreateProposalInput): Promise<SessionKeyRotationProposal> {
    return insertProposal(this.pool, input);
  }

  async addSecondSignature(
    proposalId: string,
    signer2: string,
  ): Promise<SessionKeyRotationProposal | null> {
    const { rows } = await this.pool.query(
      `UPDATE session_key_rotation_proposals
          SET signer_2 = $2, signatures_collected = 2
        WHERE proposal_id = $1 AND signer_2 IS NULL AND signer_1 <> $2
        RETURNING ${PROPOSAL_COLUMNS}`,
      [proposalId, signer2],
    );
    return rows[0] ? rowToProposal(rows[0]) : null;
  }

  async getProposal(proposalId: string): Promise<SessionKeyRotationProposal | null> {
    const { rows } = await this.pool.query(
      `SELECT ${PROPOSAL_COLUMNS} FROM session_key_rotation_proposals WHERE proposal_id = $1`,
      [proposalId],
    );
    return rows[0] ? rowToProposal(rows[0]) : null;
  }

  async markProposalExecuted(proposalId: string): Promise<void> {
    await this.pool.query(
      `UPDATE session_key_rotation_proposals
          SET executed = TRUE, executed_at = now()
        WHERE proposal_id = $1`,
      [proposalId],
    );
  }
}

/* ------------------------------------------------------------------ */
/*  In-memory                                                         */
/* ------------------------------------------------------------------ */

export interface MemorySessionKeyRegistryStoreOptions {
  /**
   * Fired once the rotation lock is held and the row reads ROTATING, with the
   * ordinal of that critical section. Lets the concurrency stress test tell
   * "before the lock" from "after the lock" deterministically.
   */
  onLocked?: (sequence: number, key: SessionKeyRecord) => void;
}

export class MemorySessionKeyRegistryStore implements SessionKeyRegistryStore {
  private keys = new Map<string, SessionKeyRecord>();
  private proposals = new Map<string, SessionKeyRotationProposal>();
  private chains = new Map<string, Promise<unknown>>();
  private sequence = 0;

  /** Ordinal of the critical section that acquired the last rotation lock. */
  rotationLockSequence: number | null = null;

  constructor(private readonly options: MemorySessionKeyRegistryStoreOptions = {}) {}

  /** Serializes every critical section for one pubkey, FIFO by call order. */
  private runExclusive<T>(pubkey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(pubkey) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.chains.set(
      pubkey,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async getKey(pubkey: string): Promise<SessionKeyRecord | null> {
    const key = this.keys.get(pubkey);
    return key ? { ...key } : null;
  }

  async registerKey(input: RegisterKeyInput): Promise<SessionKeyRecord> {
    const record: SessionKeyRecord = {
      pubkey: input.pubkey,
      status: input.status ?? "ACTIVE",
      spendingQuota: input.spendingQuota,
      spentQuota: this.keys.get(input.pubkey)?.spentQuota ?? 0n,
    };
    this.keys.set(input.pubkey, record);
    return { ...record };
  }

  reserveSpend(pubkey: string, amountStroops: bigint): Promise<ReserveSpendResult> {
    return this.runExclusive<ReserveSpendResult>(pubkey, async () => {
      const sequence = ++this.sequence;
      const key = this.keys.get(pubkey);
      if (!key) return { ok: false, reason: "NOT_FOUND" as const, sequence };
      if (key.status !== "ACTIVE") {
        return { ok: false, reason: "NOT_ACTIVE" as const, status: key.status, sequence };
      }
      const nextSpent = key.spentQuota + amountStroops;
      if (nextSpent > key.spendingQuota) {
        return {
          ok: false,
          reason: "QUOTA_EXCEEDED" as const,
          status: key.status,
          spentQuota: key.spentQuota,
          sequence,
        };
      }
      key.spentQuota = nextSpent;
      return { ok: true, status: key.status, spentQuota: nextSpent, sequence };
    });
  }

  beginRotation<T>(
    oldPubkey: string,
    cb: (ctx: RotationLockContext) => Promise<T>,
  ): Promise<BeginRotationOutcome<T>> {
    return this.runExclusive<BeginRotationOutcome<T>>(oldPubkey, async () => {
      const sequence = ++this.sequence;
      const key = this.keys.get(oldPubkey);
      if (!key) return { ok: false, reason: "NOT_FOUND" as const };
      if (key.status !== "ACTIVE") {
        return { ok: false, reason: "NOT_ACTIVE" as const, status: key.status };
      }
      key.status = "ROTATING";
      this.rotationLockSequence = sequence;
      this.options.onLocked?.(sequence, { ...key });
      const value = await cb({
        key: { ...key },
        createProposal: (input) => this.insert(input),
      });
      return { ok: true, value };
    });
  }

  async markRevoked(pubkey: string): Promise<void> {
    const key = this.keys.get(pubkey);
    if (key) key.status = "REVOKED";
  }

  private async insert(input: CreateProposalInput): Promise<SessionKeyRotationProposal> {
    const proposal: SessionKeyRotationProposal = {
      proposalId: randomUUID(),
      oldPubkey: input.oldPubkey,
      newPubkey: input.newPubkey,
      signaturesCollected: 1,
      requiredSignatures: REQUIRED_ROTATION_SIGNATURES,
      signer1: input.signer1,
      signer2: null,
      executed: false,
      createdAt: new Date().toISOString(),
      executedAt: null,
    };
    this.proposals.set(proposal.proposalId, proposal);
    return { ...proposal };
  }

  createProposal(input: CreateProposalInput): Promise<SessionKeyRotationProposal> {
    return this.insert(input);
  }

  async addSecondSignature(
    proposalId: string,
    signer2: string,
  ): Promise<SessionKeyRotationProposal | null> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.signer2 !== null || proposal.signer1 === signer2) return null;
    proposal.signer2 = signer2;
    proposal.signaturesCollected = REQUIRED_ROTATION_SIGNATURES;
    return { ...proposal };
  }

  async getProposal(proposalId: string): Promise<SessionKeyRotationProposal | null> {
    const proposal = this.proposals.get(proposalId);
    return proposal ? { ...proposal } : null;
  }

  async markProposalExecuted(proposalId: string): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return;
    proposal.executed = true;
    proposal.executedAt = new Date().toISOString();
  }
}

/** Postgres when a pool is wired up, in-memory otherwise (dev / tests). */
export function createSessionKeyRegistryStore(
  pool?: Pick<Pool, "connect" | "query">,
): SessionKeyRegistryStore {
  return pool ? new PgSessionKeyRegistryStore(pool) : new MemorySessionKeyRegistryStore();
}
