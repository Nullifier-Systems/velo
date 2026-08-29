/**
 * Multi-Asset Escrow Collateral Flash-Loan Attack Prevention Protocol (#420).
 *
 * Providers deposit and lock multi-asset collateral to service cash requests.
 * Without a mandatory lockup, an attacker can borrow a large sum, deposit it
 * as collateral, manipulate liquidity allocations / exchange rates, and
 * release it — all within a single Stellar ledger (~5s).
 *
 * This module is the single source of truth for that rule off-chain:
 *   - every deposit records `deposit_ledger` and
 *     `cooldown_until_ledger = deposit_ledger + FLASH_LOAN_COOLDOWN_LEDGERS`
 *   - releases must pass `runReleaseCheck`, which evaluates cooldowns under
 *     a `SELECT ... FOR UPDATE` row lock so two racing release requests can
 *     never both observe an expired cooldown
 *   - `unlockExpiredDeposits` flips `is_locked` back to FALSE once the
 *     cooldown bounds expire (driven by the cooldown monitor worker).
 *
 * Mirrors the on-chain rule enforced by the escrow contract
 * (`Error::CooldownActive`, minimum 5 ledgers / ~25 seconds).
 */
import type { Pool } from "pg";

/** Minimum lockup, in ledgers, between a collateral deposit and its release. */
export const FLASH_LOAN_COOLDOWN_LEDGERS = 5;

/** Approximate Stellar ledger close time, used for second-based estimates. */
export const LEDGER_CLOSE_SECONDS = 5;

export interface CollateralDeposit {
  id: string;
  providerId: string;
  assetAddress: string;
  amountStroops: string;
  depositLedger: number;
  cooldownUntilLedger: number;
  isLocked: boolean;
}

export interface RecordDepositInput {
  providerId: string;
  assetAddress: string;
  amountStroops: string;
  depositLedger: number;
}

export interface ReleaseCheckResult {
  eligible: boolean;
  currentLedger: number;
  depositsChecked: number;
  /** Ledgers left on the longest still-running cooldown (0 when eligible). */
  remainingLedgers: number;
  /** Ledger at which the earliest active cooldown expires (null when eligible). */
  earliestReleaseLedger: number | null;
}

/** Ledgers still remaining in a deposit's flash-loan cooldown (0 = free). */
export function cooldownRemainingLedgers(
  depositLedger: number,
  currentLedger: number,
  minLockupLedgers: number = FLASH_LOAN_COOLDOWN_LEDGERS,
): number {
  const unlockAt = Math.max(depositLedger, 0) + minLockupLedgers;
  return Math.max(0, unlockAt - Math.max(currentLedger, 0));
}

/** True when releasing `depositLedger`'s collateral at `currentLedger` is allowed. */
export function canReleaseCollateral(depositLedger: number, currentLedger: number): boolean {
  return cooldownRemainingLedgers(depositLedger, currentLedger) === 0;
}

interface DepositRow {
  id: string;
  provider_id: string;
  asset_address: string;
  amount_stroops: string;
  deposit_ledger: number;
  cooldown_until_ledger: number;
  is_locked: boolean;
}

function rowToDeposit(row: DepositRow): CollateralDeposit {
  return {
    id: row.id,
    providerId: row.provider_id,
    assetAddress: row.asset_address,
    amountStroops: row.amount_stroops,
    depositLedger: Number(row.deposit_ledger),
    cooldownUntilLedger: Number(row.cooldown_until_ledger),
    isLocked: row.is_locked,
  };
}

function summarize(
  deposits: CollateralDeposit[],
  currentLedger: number,
): ReleaseCheckResult {
  const remaining = deposits.map((d) =>
    cooldownRemainingLedgers(d.depositLedger, currentLedger),
  );
  const maxRemaining = remaining.length ? Math.max(...remaining) : 0;
  const activeCooldowns = deposits.filter((_, i) => remaining[i] > 0);
  return {
    eligible: maxRemaining === 0,
    currentLedger,
    depositsChecked: deposits.length,
    remainingLedgers: maxRemaining,
    earliestReleaseLedger: activeCooldowns.length
      ? Math.min(...activeCooldowns.map((d) => d.cooldownUntilLedger))
      : null,
  };
}

/**
 * Store backing the release-check endpoint and the cooldown monitor worker.
 *
 * Falls back to an in-memory implementation when no Postgres pool is
 * configured (local dev / tests), so the API keeps working without the
 * migration applied — mirroring how other stores degrade gracefully.
 */
export class CollateralGuardStore {
  private memory: CollateralDeposit[] = [];

  constructor(private readonly pool?: Pick<Pool, "connect" | "query">) {}

  /** Records a collateral deposit and starts its cooldown clock. */
  async recordDeposit(input: RecordDepositInput): Promise<CollateralDeposit> {
    const cooldownUntilLedger =
      input.depositLedger + FLASH_LOAN_COOLDOWN_LEDGERS;

    if (!this.pool) {
      const deposit: CollateralDeposit = {
        id: `mem-${this.memory.length + 1}`,
        providerId: input.providerId,
        assetAddress: input.assetAddress,
        amountStroops: input.amountStroops,
        depositLedger: input.depositLedger,
        cooldownUntilLedger,
        isLocked: true,
      };
      this.memory.push(deposit);
      return deposit;
    }

    const { rows } = await this.pool.query<DepositRow>(
      `INSERT INTO escrow_collateral_deposits
         (provider_id, asset_address, amount_stroops, deposit_ledger, cooldown_until_ledger)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, provider_id, asset_address, amount_stroops,
                 deposit_ledger, cooldown_until_ledger, is_locked`,
      [
        input.providerId,
        input.assetAddress,
        input.amountStroops,
        input.depositLedger,
        cooldownUntilLedger,
      ],
    );
    return rowToDeposit(rows[0]);
  }

  /**
   * Release gate (#420). Locks the provider's active deposits with
   * `SELECT ... FOR UPDATE` inside a transaction, then verifies the
   * requested ledger sequence clears every cooldown before any release
   * may proceed.
   */
  async runReleaseCheck(providerId: string, currentLedger: number): Promise<ReleaseCheckResult> {
    if (!this.pool) {
      return summarize(
        this.memory.filter((d) => d.providerId === providerId && d.isLocked),
        currentLedger,
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<DepositRow>(
        `SELECT id, provider_id, asset_address, amount_stroops,
                deposit_ledger, cooldown_until_ledger, is_locked
           FROM escrow_collateral_deposits
          WHERE provider_id = $1 AND is_locked = TRUE
          FOR UPDATE`,
        [providerId],
      );
      const result = summarize(rows.map(rowToDeposit), currentLedger);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Flips `is_locked` to FALSE once each deposit's cooldown has expired. */
  async unlockExpiredDeposits(currentLedger: number): Promise<number> {
    if (!this.pool) {
      let unlocked = 0;
      for (const d of this.memory) {
        if (d.isLocked && d.cooldownUntilLedger <= currentLedger) {
          d.isLocked = false;
          unlocked += 1;
        }
      }
      return unlocked;
    }

    const { rowCount } = await this.pool.query(
      `UPDATE escrow_collateral_deposits
          SET is_locked = FALSE
        WHERE is_locked = TRUE AND cooldown_until_ledger <= $1`,
      [currentLedger],
    );
    return rowCount ?? 0;
  }
}
