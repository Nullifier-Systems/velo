import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { runBatchTick } from "./payout-batcher.js";
import { batchReleaseEscrow } from "./stellar.js";
import { saveCashRequest, getCashRequest, CashRequestRecord } from "./store.js";

vi.mock("./stellar.js", () => ({
  batchReleaseEscrow: vi.fn(),
}));

// Mirrors payout-batcher.ts's defaults (no env overrides set in this test run).
const BATCH_THRESHOLD_COUNT = 5;
const BATCH_WINDOW_MS = 5 * 60 * 1000;

function queueTrade(seller: string, overrides: Partial<CashRequestRecord> = {}): CashRequestRecord {
  const id = randomUUID();
  const record: CashRequestRecord = {
    id,
    contractId: "dummy_contract",
    seller,
    buyer: "GBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUY",
    amountStroops: "10000000",
    secretHex: `secret-${id}`,
    secretHashHex: "hash",
    qrPayload: "qr",
    status: "pending_batch",
    createdAt: new Date().toISOString(),
    batchQueuedAt: new Date().toISOString(),
    ...overrides,
  };
  saveCashRequest(record);
  return record;
}

describe("payout-batcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: batch_release "succeeds" and releases everything asked for.
    (batchReleaseEscrow as any).mockImplementation(async (params: any) =>
      params.releases.map((r: any) => r.tradeId)
    );
  });

  it("flushes a provider's queue once it reaches the count threshold", async () => {
    const seller = `G_THRESHOLD_${randomUUID()}`;
    const trades = Array.from({ length: BATCH_THRESHOLD_COUNT }, () => queueTrade(seller));

    await runBatchTick();

    expect(batchReleaseEscrow).toHaveBeenCalledTimes(1);
    for (const t of trades) {
      expect(getCashRequest(t.id)?.status).toBe("released");
    }
  });

  it("does not flush a fresh, below-threshold queue", async () => {
    const seller = `G_BELOW_THRESHOLD_${randomUUID()}`;
    const trades = Array.from({ length: BATCH_THRESHOLD_COUNT - 1 }, () => queueTrade(seller));

    await runBatchTick();

    expect(batchReleaseEscrow).not.toHaveBeenCalled();
    for (const t of trades) {
      expect(getCashRequest(t.id)?.status).toBe("pending_batch");
    }
  });

  it("flushes a stale queue once the schedule window has passed, even below threshold", async () => {
    const seller = `G_WINDOW_${randomUUID()}`;
    const staleAt = new Date(Date.now() - BATCH_WINDOW_MS - 1_000).toISOString();
    const trade = queueTrade(seller, { batchQueuedAt: staleAt, createdAt: staleAt });

    await runBatchTick();

    expect(batchReleaseEscrow).toHaveBeenCalledTimes(1);
    expect(getCashRequest(trade.id)?.status).toBe("released");
  });

  it("leaves trades pending_batch when batch_release fails", async () => {
    const seller = `G_FAILURE_${randomUUID()}`;
    (batchReleaseEscrow as any).mockRejectedValueOnce(new Error("simulation failed"));
    const trades = Array.from({ length: BATCH_THRESHOLD_COUNT }, () => queueTrade(seller));

    await runBatchTick();

    expect(batchReleaseEscrow).toHaveBeenCalledTimes(1);
    for (const t of trades) {
      expect(getCashRequest(t.id)?.status).toBe("pending_batch");
    }

    // Drain this provider's queue so it doesn't stay eligible-to-flush
    // (still at the count threshold) and leak into later tests' tick calls.
    await runBatchTick();
    for (const t of trades) {
      expect(getCashRequest(t.id)?.status).toBe("released");
    }
  });

  it("only marks contract-returned ids as released, leaving the rest queued for retry", async () => {
    const seller = `G_PARTIAL_${randomUUID()}`;
    const trades = Array.from({ length: BATCH_THRESHOLD_COUNT }, () => queueTrade(seller));
    const keepPending = trades[0].id;

    (batchReleaseEscrow as any).mockImplementationOnce(async (params: any) =>
      params.releases.map((r: any) => r.tradeId).filter((id: string) => id !== keepPending)
    );

    await runBatchTick();

    expect(getCashRequest(keepPending)?.status).toBe("pending_batch");
    for (const t of trades.slice(1)) {
      expect(getCashRequest(t.id)?.status).toBe("released");
    }
  });
});
