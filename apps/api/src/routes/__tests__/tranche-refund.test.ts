import { describe, it, expect, vi } from "vitest";
import { app } from "../../app.js";
import { pgPool } from "../../app.js";
import { getCashRequest, saveCashRequest } from "../../lib/store.js";
import { getLatestLedgerSequence } from "../../lib/stellar.js";

vi.mock("../../lib/stellar.js", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getLatestLedgerSequence: vi.fn().mockResolvedValue(100),
  };
});

describe("Tranche Refund API", () => {
  it("should return 400 if timeout not reached", async () => {
    if (!pgPool) return;
    
    // Setup DB
    const client = await pgPool.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tranche_refund_schedules (trade_id, total_tranches, unreleased_tranches, unreleased_amount, timeout_ledger_sequence)
       VALUES ('test_trade_1', 3, 2, 200, 150)`
    );
    await client.query("COMMIT");
    client.release();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tranche-refund/trigger",
      payload: { tradeId: "test_trade_1".padEnd(64, "0") }
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error.code).toBe("TIMEOUT_NOT_REACHED");
  });
});
