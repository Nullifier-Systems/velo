import { describe, it, expect, vi } from "vitest";
import {
  CollateralGuardStore,
  FLASH_LOAN_COOLDOWN_LEDGERS,
  LEDGER_CLOSE_SECONDS,
  canReleaseCollateral,
  cooldownRemainingLedgers,
} from "./collateralGuard.js";

describe("collateral flash-loan protection constants (#420)", () => {
  it("matches the on-chain 5-ledger (~25s) minimum lockup", () => {
    expect(FLASH_LOAN_COOLDOWN_LEDGERS).toBe(5);
    expect(LEDGER_CLOSE_SECONDS).toBe(5);
    expect(FLASH_LOAN_COOLDOWN_LEDGERS * LEDGER_CLOSE_SECONDS).toBe(25);
  });
});

describe("cooldownRemainingLedgers", () => {
  it("blocks same-ledger releases entirely", () => {
    expect(cooldownRemainingLedgers(1_000, 1_000)).toBe(5);
    expect(canReleaseCollateral(1_000, 1_000)).toBe(false);
  });

  it("decays one ledger at a time and unlocks after the full lockup", () => {
    expect(cooldownRemainingLedgers(1_000, 1_004)).toBe(1);
    expect(canReleaseCollateral(1_000, 1_004)).toBe(false);
    expect(cooldownRemainingLedgers(1_000, 1_005)).toBe(0);
    expect(canReleaseCollateral(1_000, 1_005)).toBe(true);
    expect(canReleaseCollateral(1_000, 50_000)).toBe(true);
  });
});

describe("CollateralGuardStore (in-memory fallback)", () => {
  it("records deposits with a cooldown bound 5 ledgers out", async () => {
    const store = new CollateralGuardStore();
    const deposit = await store.recordDeposit({
      providerId: "prov-1",
      assetAddress: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZ4MWQ5VBSNFYQ2YL",
      amountStroops: "1000000000",
      depositLedger: 5_000,
    });
    expect(deposit.cooldownUntilLedger).toBe(5_000 + FLASH_LOAN_COOLDOWN_LEDGERS);
    expect(deposit.isLocked).toBe(true);
  });

  it("runReleaseCheck rejects while any locked deposit is cooling down", async () => {
    const store = new CollateralGuardStore();
    await store.recordDeposit({
      providerId: "prov-1",
      assetAddress: "A",
      amountStroops: "10",
      depositLedger: 5_000,
    });

    const blocked = await store.runReleaseCheck("prov-1", 5_002);
    expect(blocked.eligible).toBe(false);
    expect(blocked.remainingLedgers).toBe(3);
    expect(blocked.earliestReleaseLedger).toBe(5_005);

    const ok = await store.runReleaseCheck("prov-1", 5_005);
    expect(ok.eligible).toBe(true);
    expect(ok.remainingLedgers).toBe(0);
  });

  it("ignores other providers and already-unlocked deposits", async () => {
    const store = new CollateralGuardStore();
    await store.recordDeposit({
      providerId: "prov-1",
      assetAddress: "A",
      amountStroops: "10",
      depositLedger: 5_000,
    });
    await store.recordDeposit({
      providerId: "prov-2",
      assetAddress: "A",
      amountStroops: "10",
      depositLedger: 9_999,
    });

    // prov-2's fresh deposit must not affect prov-1.
    const result = await store.runReleaseCheck("prov-1", 5_005);
    expect(result.eligible).toBe(true);
    expect(result.depositsChecked).toBe(1);
  });

  it("unlockExpiredDeposits flips only expired rows", async () => {
    const store = new CollateralGuardStore();
    await store.recordDeposit({ providerId: "p", assetAddress: "A", amountStroops: "1", depositLedger: 100 });
    await store.recordDeposit({ providerId: "p", assetAddress: "B", amountStroops: "1", depositLedger: 200 });

    expect(await store.unlockExpiredDeposits(105)).toBe(1); // first expires at 105
    expect(await store.unlockExpiredDeposits(205)).toBe(1); // second expires at 205
    expect(await store.unlockExpiredDeposits(300)).toBe(0);

    const result = await store.runReleaseCheck("p", 205);
    expect(result.depositsChecked).toBe(0); // nothing locked anymore
  });
});

describe("CollateralGuardStore (postgres path)", () => {
  function makePool() {
    const queries: { sql: string; values?: unknown[] }[] = [];
    const inTransaction = vi.fn(async (fn: (c: unknown) => Promise<unknown>) => {
      await fn({});
    });
    const pool = {
      connect: vi.fn(async () => ({
        query: async (sql: string, values?: unknown[]) => {
          queries.push({ sql, values });
          if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
          if (sql.startsWith("SELECT")) {
            return {
              rows: [
                {
                  id: "row-1",
                  provider_id: "prov-1",
                  asset_address: "A",
                  amount_stroops: "10",
                  deposit_ledger: 5_000,
                  cooldown_until_ledger: 5_005,
                  is_locked: true,
                },
              ],
            };
          }
          return { rows: [], rowCount: 1 };
        },
        release: vi.fn(),
      })),
      query: vi.fn(),
    };
    return { pool: pool as never, queries };
  }

  it("runs the release check under SELECT ... FOR UPDATE inside a transaction", async () => {
    const { pool, queries } = makePool();
    const store = new CollateralGuardStore(pool);

    const result = await store.runReleaseCheck("prov-1", 5_003);

    expect(result.eligible).toBe(false);
    expect(result.remainingLedgers).toBe(2);

    const sqls = queries.map((q) => q.sql.replace(/\s+/g, " ").trim());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toContain("FOR UPDATE");
    expect(sqls[1]).toContain("provider_id = $1");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    expect(queries[1].values).toEqual(["prov-1"]);
  });

  it("recordDeposit inserts the computed cooldown bound", async () => {
    const captured: { sql: string; values?: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        captured.push({ sql, values });
        return {
          rows: [
            {
              id: "row-1",
              provider_id: "prov-1",
              asset_address: "A",
              amount_stroops: "7",
              deposit_ledger: 42,
              cooldown_until_ledger: 47,
              is_locked: true,
            },
          ],
        };
      },
    } as never;

    const deposit = await new CollateralGuardStore(pool).recordDeposit({
      providerId: "prov-1",
      assetAddress: "A",
      amountStroops: "7",
      depositLedger: 42,
    });

    expect(deposit.cooldownUntilLedger).toBe(47);
    expect(captured[0].sql).toContain("INSERT INTO escrow_collateral_deposits");
    expect(captured[0].values).toEqual(["prov-1", "A", "7", 42, 47]);
  });
});
