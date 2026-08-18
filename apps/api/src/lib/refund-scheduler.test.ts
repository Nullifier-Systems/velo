import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveCashRequest,
  clearStore,
  getCashRequest,
  type CashRequestRecord,
} from "./store.js";
import {
  runRefundCountdownTick,
  computeRefundAccounting,
  resetRefundCountdownState,
  stopRefundCountdownScheduler,
  type RefundCountdownOptions,
} from "./refund-scheduler.js";

const CONTRACT_ID = "CBQHTOHBCD4V6O5BSTL3EJOXQX5EV7VBZTSWZVXZG2JNYGVG5ZX7ZX7E";
const SELLER = "GBUQWP3BOUZX34ULNQG23RQ6F4BQXQMJG7YTJWD3JSDT7Z7M2MKAQQ3Q";
const BUYER = "GDUTHCF37UX32EMANXIL2WOOVEDP47GHBOENQWP7CJX3ULSQ5DVEHV";

function makeTrade(overrides: Partial<CashRequestRecord> = {}): CashRequestRecord {
  return {
    id: "00".repeat(32),
    contractId: CONTRACT_ID,
    seller: SELLER,
    buyer: BUYER,
    amountStroops: "1000000000",
    secretHex: "aa".repeat(32),
    secretHashHex: "bb".repeat(32),
    qrPayload: "velo:claim:1",
    status: "locked",
    createdAt: new Date(0).toISOString(),
    timeoutLedger: 1000,
    ...overrides,
  };
}

/** Fresh mocks wired as scheduler dependencies, so no real chain/webhook calls fire. */
function mockDeps(latestLedger: number): {
  options: RefundCountdownOptions;
  mocks: {
    getLatestLedger: ReturnType<typeof vi.fn>;
    refund: ReturnType<typeof vi.fn>;
    sendCountdownAlert: ReturnType<typeof vi.fn>;
    sendRefundAlert: ReturnType<typeof vi.fn>;
    notifyStatus: ReturnType<typeof vi.fn>;
    notifyUser: ReturnType<typeof vi.fn>;
    emitAlert: ReturnType<typeof vi.fn>;
    onInvariantViolation: ReturnType<typeof vi.fn>;
  };
} {
  const mocks = {
    getLatestLedger: vi.fn().mockResolvedValue(latestLedger),
    refund: vi.fn().mockResolvedValue({ hash: "deadbeef" }),
    sendCountdownAlert: vi.fn().mockResolvedValue(undefined),
    sendRefundAlert: vi.fn().mockResolvedValue(undefined),
    notifyStatus: vi.fn().mockResolvedValue(undefined),
    notifyUser: vi.fn().mockResolvedValue(undefined),
    emitAlert: vi.fn().mockResolvedValue(undefined),
    onInvariantViolation: vi.fn().mockResolvedValue(undefined),
  };
  return {
    mocks,
    options: {
      getLatestLedger: mocks.getLatestLedger as any,
      refund: mocks.refund as any,
      sendCountdownAlert: mocks.sendCountdownAlert as any,
      sendRefundAlert: mocks.sendRefundAlert as any,
      notifyStatus: mocks.notifyStatus as any,
      notifyUser: mocks.notifyUser as any,
      emitAlert: mocks.emitAlert as any,
      feeBps: 100,
    },
  };
}

describe("refund-scheduler", () => {
  beforeEach(() => {
    clearStore();
    resetRefundCountdownState();
  });

  afterEach(() => {
    stopRefundCountdownScheduler();
    vi.clearAllMocks();
  });

  describe("AC1: pre-expiry countdown alert", () => {
    it("alerts when a locked trade is within the 100-ledger threshold", async () => {
      saveCashRequest(makeTrade({ timeoutLedger: 1000 }));
      const { options, mocks } = mockDeps(950); // 50 ledgers out

      const result = await runRefundCountdownTick(options);

      expect(mocks.sendCountdownAlert).toHaveBeenCalledTimes(1);
      expect(mocks.sendCountdownAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          tradeId: "00".repeat(32),
          amountStroops: "1000000000",
          buyer: BUYER,
          seller: SELLER,
          timeoutLedger: 1000,
          latestLedger: 950,
          ledgersUntilRefund: 50,
          estimatedSecondsUntilRefund: 300, // 50 ledgers * 6s
        }),
      );
      expect(mocks.refund).not.toHaveBeenCalled();
      expect(result.countdownAlertsSent).toBe(1);
    });

    it("fires exactly at the threshold boundary (100 ledgers out)", async () => {
      saveCashRequest(makeTrade({ timeoutLedger: 1000 }));
      const { options, mocks } = mockDeps(900); // exactly 100 out

      await runRefundCountdownTick(options);

      expect(mocks.sendCountdownAlert).toHaveBeenCalledTimes(1);
    });

    it("does not alert when the trade is further out than the threshold", async () => {
      saveCashRequest(makeTrade({ timeoutLedger: 1000 }));
      const { options, mocks } = mockDeps(800); // 200 out

      const result = await runRefundCountdownTick(options);

      expect(mocks.sendCountdownAlert).not.toHaveBeenCalled();
      expect(result.countdownAlertsSent).toBe(0);
    });

    it("alerts only once across repeated ticks in the same window (dedup)", async () => {
      saveCashRequest(makeTrade({ timeoutLedger: 1000 }));
      const { options, mocks } = mockDeps(950);

      await runRefundCountdownTick(options);
      await runRefundCountdownTick(options);
      await runRefundCountdownTick(options);

      expect(mocks.sendCountdownAlert).toHaveBeenCalledTimes(1);
    });

    it("honours a custom alertThresholdLedgers override", async () => {
      saveCashRequest(makeTrade({ timeoutLedger: 1000 }));
      const { options, mocks } = mockDeps(800); // 200 out
      options.alertThresholdLedgers = 250;

      await runRefundCountdownTick(options);

      expect(mocks.sendCountdownAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe("AC2: automated refund on timeout breach", () => {
    it("refunds a locked trade once the timeout is reached", async () => {
      saveCashRequest(makeTrade({ timeoutLedger: 1000 }));
      const { options, mocks } = mockDeps(1000); // latest == timeout

      const result = await runRefundCountdownTick(options);

      expect(mocks.refund).toHaveBeenCalledWith({
        contractId: CONTRACT_ID,
        tradeId: "00".repeat(32),
      });
      expect(getCashRequest("00".repeat(32))?.status).toBe("refunded");
      expect(mocks.notifyStatus).toHaveBeenCalledWith("00".repeat(32), "refunded");
      expect(mocks.notifyUser).toHaveBeenCalledWith(
        expect.objectContaining({ id: "00".repeat(32) }),
        "refunded",
        "en",
      );
      expect(mocks.sendRefundAlert).toHaveBeenCalledTimes(1);
      expect(mocks.sendCountdownAlert).not.toHaveBeenCalled();
      expect(result.refunded).toEqual(["00".repeat(32)]);
    });

    it("also refunds a store trade already flipped to expired", async () => {
      saveCashRequest(makeTrade({ status: "expired", timeoutLedger: 1000 }));
      const { options, mocks } = mockDeps(1200);

      const result = await runRefundCountdownTick(options);

      expect(mocks.refund).toHaveBeenCalledTimes(1);
      expect(getCashRequest("00".repeat(32))?.status).toBe("refunded");
      expect(result.refunded).toHaveLength(1);
    });

    it("leaves the trade untouched and records an error when refund fails", async () => {
      saveCashRequest(makeTrade({ timeoutLedger: 1000 }));
      const { options, mocks } = mockDeps(1000);
      mocks.refund.mockRejectedValueOnce(new Error("rpc down"));

      const result = await runRefundCountdownTick(options);

      expect(getCashRequest("00".repeat(32))?.status).toBe("locked");
      expect(mocks.sendRefundAlert).not.toHaveBeenCalled();
      expect(result.refunded).toHaveLength(0);
      expect(result.errors).toBe(1);
    });

    it("does not touch trades in non-refundable states", async () => {
      saveCashRequest(makeTrade({ id: "01".repeat(32), status: "released" }));
      saveCashRequest(makeTrade({ id: "02".repeat(32), status: "refunded" }));
      saveCashRequest(makeTrade({ id: "03".repeat(32), status: "disputed" }));
      saveCashRequest(makeTrade({ id: "04".repeat(32), status: "pending_signature" }));
      const { options, mocks } = mockDeps(5000);

      const result = await runRefundCountdownTick(options);

      expect(mocks.refund).not.toHaveBeenCalled();
      expect(mocks.sendCountdownAlert).not.toHaveBeenCalled();
      expect(result.scanned).toBe(0);
    });

    it("skips locked trades that carry no timeout ledger", async () => {
      saveCashRequest(makeTrade({ timeoutLedger: undefined }));
      const { options, mocks } = mockDeps(9999);

      const result = await runRefundCountdownTick(options);

      expect(result.scanned).toBe(0);
      expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("returns early without scanning when the ledger fetch fails", async () => {
      saveCashRequest(makeTrade({ timeoutLedger: 1000 }));
      const { options, mocks } = mockDeps(1000);
      mocks.getLatestLedger.mockRejectedValueOnce(new Error("no rpc"));

      const result = await runRefundCountdownTick(options);

      expect(result.scanned).toBe(0);
      expect(mocks.refund).not.toHaveBeenCalled();
    });
  });

  describe("AC3: accounting invariant verification", () => {
    it("balances a mixed released/unreleased tranche refund", async () => {
      saveCashRequest(
        makeTrade({
          timeoutLedger: 1000,
          tranches: [
            { amountStroops: "600000000", secretHashHex: "cc".repeat(32), released: true },
            { amountStroops: "400000000", secretHashHex: "dd".repeat(32), released: false },
          ],
        }),
      );
      const { options, mocks } = mockDeps(1000);

      const result = await runRefundCountdownTick(options);

      expect(result.refunded).toHaveLength(1);
      expect(result.invariantViolations).toHaveLength(0);
      expect(mocks.onInvariantViolation).not.toHaveBeenCalled();
    });

    it("flags a violation when tranches do not sum to the original amount", async () => {
      saveCashRequest(
        makeTrade({
          amountStroops: "1000000000",
          timeoutLedger: 1000,
          // Deliberately corrupt: tranches sum to 800000000, not 1000000000.
          tranches: [
            { amountStroops: "400000000", secretHashHex: "cc".repeat(32), released: false },
            { amountStroops: "400000000", secretHashHex: "dd".repeat(32), released: false },
          ],
        }),
      );
      const { options, mocks } = mockDeps(1000);
      options.onInvariantViolation = mocks.onInvariantViolation as any;

      const result = await runRefundCountdownTick(options);

      expect(result.refunded).toHaveLength(1);
      expect(result.invariantViolations).toEqual(["00".repeat(32)]);
      expect(mocks.onInvariantViolation).toHaveBeenCalledTimes(1);
    });

    it("emits a webhook alert on violation when no custom handler is given", async () => {
      saveCashRequest(
        makeTrade({
          amountStroops: "1000000000",
          timeoutLedger: 1000,
          tranches: [
            { amountStroops: "400000000", secretHashHex: "cc".repeat(32), released: false },
          ],
        }),
      );
      const { options, mocks } = mockDeps(1000); // no onInvariantViolation set

      await runRefundCountdownTick(options);

      expect(mocks.emitAlert).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Refund accounting invariant violated" }),
      );
    });
  });

  describe("computeRefundAccounting", () => {
    it("treats a plain (no-tranche) trade as a full buyer refund", () => {
      const acct = computeRefundAccounting(makeTrade({ amountStroops: "1000000000" }), 100);
      expect(acct.buyerRefundStroops).toBe(1000000000n);
      expect(acct.sellerPayoutStroops).toBe(0n);
      expect(acct.feeStroops).toBe(0n);
      expect(acct.balances).toBe(true);
    });

    it("splits fully-released tranches into seller payout and fees at feeBps", () => {
      const acct = computeRefundAccounting(
        makeTrade({
          amountStroops: "1000000000",
          tranches: [
            { amountStroops: "600000000", secretHashHex: "cc".repeat(32), released: true },
            { amountStroops: "400000000", secretHashHex: "dd".repeat(32), released: true },
          ],
        }),
        250, // 2.5%
      );
      // fee = floor(amount * 250 / 10000): 15000000 + 10000000 = 25000000
      expect(acct.feeStroops).toBe(25000000n);
      expect(acct.sellerPayoutStroops).toBe(975000000n);
      expect(acct.buyerRefundStroops).toBe(0n);
      expect(acct.balances).toBe(true);
    });

    it("balances for any feeBps because payout + fee == tranche amount", () => {
      for (const feeBps of [0, 1, 100, 333, 10000]) {
        const acct = computeRefundAccounting(
          makeTrade({
            amountStroops: "1000000000",
            tranches: [
              { amountStroops: "700000000", secretHashHex: "cc".repeat(32), released: true },
              { amountStroops: "300000000", secretHashHex: "dd".repeat(32), released: false },
            ],
          }),
          feeBps,
        );
        expect(acct.balances).toBe(true);
        expect(
          acct.sellerPayoutStroops + acct.buyerRefundStroops + acct.feeStroops,
        ).toBe(acct.originalStroops);
      }
    });

    it("reports balances=false when tranche amounts do not sum to the original", () => {
      const acct = computeRefundAccounting(
        makeTrade({
          amountStroops: "1000000000",
          tranches: [
            { amountStroops: "400000000", secretHashHex: "cc".repeat(32), released: false },
            { amountStroops: "400000000", secretHashHex: "dd".repeat(32), released: false },
          ],
        }),
        100,
      );
      expect(acct.balances).toBe(false);
    });
  });
});
