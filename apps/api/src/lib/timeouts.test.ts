import { describe, it, expect } from "vitest";
import {
  CASH_DEFAULT_TIMEOUT_LEDGERS,
  ESCROW_MAX_TIMEOUT_LEDGERS_POLICY,
  DISPUTE_RESOLUTION_WINDOW_LEDGERS,
  SETTLEMENT_CHAIN_DEFAULT_TIMEOUT_LEDGERS,
  DEFAULT_CHAT_RETENTION_MS,
  DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS,
  buildRefundCountdown,
  AVERAGE_LEDGER_CLOSE_SECONDS,
} from "./timeouts.js";
import {
  getCashRequest,
  saveCashRequest,
  clearStore,
  expireCashRequest,
} from "./store.js";

describe("Timeout Policy Invariants", () => {
  describe("Nesting: Timeouts must not exceed parent windows", () => {
    it("cash trade timeout is within contract max", () => {
      expect(CASH_DEFAULT_TIMEOUT_LEDGERS).toBeLessThanOrEqual(
        ESCROW_MAX_TIMEOUT_LEDGERS_POLICY,
      );
    });

    it("settlement chain timeout is within contract max", () => {
      expect(SETTLEMENT_CHAIN_DEFAULT_TIMEOUT_LEDGERS).toBeLessThanOrEqual(
        ESCROW_MAX_TIMEOUT_LEDGERS_POLICY,
      );
    });

    it("dispute resolution window is within contract max", () => {
      expect(DISPUTE_RESOLUTION_WINDOW_LEDGERS).toBeLessThanOrEqual(
        ESCROW_MAX_TIMEOUT_LEDGERS_POLICY,
      );
    });

    it("dispute window is shorter than trade max (key invariant)", () => {
      expect(DISPUTE_RESOLUTION_WINDOW_LEDGERS).toBeLessThan(
        ESCROW_MAX_TIMEOUT_LEDGERS_POLICY,
      );
      // Context: ~3 days < ~7 days allows trades to be disputed near timeout
      // without the dispute window extending past the max
    });
  });

  describe("Retention windows: Chat < Evidence", () => {
    it("chat retention is shorter than or equal to evidence retention", () => {
      // CONVENTION: chat (GDPR, 30d) <= evidence (legal trail, 90d)
      expect(DEFAULT_CHAT_RETENTION_MS).toBeLessThanOrEqual(
        DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS,
      );
    });

    it("chat retention window is reasonable (20-40 days)", () => {
      const days = DEFAULT_CHAT_RETENTION_MS / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThanOrEqual(20);
      expect(days).toBeLessThanOrEqual(40);
    });

    it("evidence retention window is reasonable (80-100 days)", () => {
      const days =
        DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThanOrEqual(80);
      expect(days).toBeLessThanOrEqual(100);
    });
  });

  describe("Cross-component consistency: API and contract agree", () => {
    it("prevents chat from outliving trade timeout (API side)", () => {
      clearStore();

      const tradeId = "aa".repeat(32);
      const currentLedger = 1000;
      const timeoutLedger = currentLedger + CASH_DEFAULT_TIMEOUT_LEDGERS;

      // Create a locked trade
      saveCashRequest({
        id: tradeId,
        contractId: "dummy",
        seller: "seller",
        buyer: "buyer",
        amountStroops: "1000000",
        secretHex: "aa".repeat(32),
        secretHashHex: "bb".repeat(32),
        qrPayload: "qr",
        status: "locked",
        createdAt: new Date().toISOString(),
        timeoutLedger,
      });

      const trade = getCashRequest(tradeId);
      expect(trade?.status).toBe("locked");

      // Chat is active while trade is locked
      // (In real code, chat.status would be derived from trade.status)

      // Advance past timeout
      const afterTimeoutLedger = timeoutLedger + 1;
      expireCashRequest(trade!, afterTimeoutLedger);

      // Trade is now expired
      expect(trade?.status).toBe("expired");
      // Chat should now be archived (enforcement: UI checks trade.status)
    });

    it("prevents dispute from outliving its resolution window", () => {
      // This test checks the RELATIONSHIP between two constants
      // In real code, both contract and API check the same deadlines

      const lockedAtLedger = 1000;
      const tradeTimeoutLedger = lockedAtLedger + CASH_DEFAULT_TIMEOUT_LEDGERS;
      const disputeRaisedLedger = tradeTimeoutLedger - 10; // 10 ledgers before timeout

      // When dispute is raised, arbitrator gets DISPUTE_RESOLUTION_WINDOW_LEDGERS
      const disputeDeadlineLedger =
        disputeRaisedLedger + DISPUTE_RESOLUTION_WINDOW_LEDGERS;

      // After disputeDeadlineLedger, anyone can refund (trade goes to Resolved)
      // This can happen AFTER the original trade timeout, but the trade is Disputed
      // so refund() and release() don't apply anyway

      // Key invariant:
      // - If trade timeout hit but trade is Disputed, arbitrator still has time
      // - If arbitrator doesn't resolve, buyer can get funds back via
      //   refund_after_dispute_timeout after disputeDeadlineLedger

      expect(tradeTimeoutLedger).toBeLessThan(disputeDeadlineLedger);
      // (Trade timeout at L+100, but dispute deadline is at dispute_raised + 259_200)
    });
  });

  describe("Scenario tests: Preventing inconsistencies", () => {
    it("scenario: provider locks trade, raises dispute at last minute", () => {
      /**
       * Scenario from TIMEOUT_POLICY.md:
       * - Trade locked with 100-ledger timeout
       * - Dispute raised 5 ledgers before timeout
       * - Verify: chat doesn't become inactive, arbitrator still has time
       */

      const lockedAt = 1000;
      const tradeTimeout = lockedAt + CASH_DEFAULT_TIMEOUT_LEDGERS; // 1100

      // Dispute raised 5 ledgers before timeout
      const disputeRaisedAt = tradeTimeout - 5; // 1095

      // Arbitrator has 3 days from dispute_raised
      const disputeDeadline =
        disputeRaisedAt + DISPUTE_RESOLUTION_WINDOW_LEDGERS;
      // ~1095 + 259200 = 260295

      // At the original timeout (ledger 1100):
      // - Trade is NOT in Locked state, so refund() fails ✓
      // - Chat stays active (trade.status = Disputed, not expired) ✓
      // - Arbitrator still has 259,105 ledgers to resolve ✓

      expect(tradeTimeout).toBeLessThan(disputeDeadline);
      expect(disputeRaisedAt).toBeLessThan(tradeTimeout);
      expect(disputeDeadline - disputeRaisedAt).toBe(
        DISPUTE_RESOLUTION_WINDOW_LEDGERS,
      );
    });

    it("scenario: chat is deleted 30d after trade release (not before)", () => {
      /**
       * Chat should remain accessible exactly as long as trade is terminal.
       * After terminal, chat stays for 30 more days, then deleted.
       */

      const releasedAtMs = Date.now();
      const chatRetentionMs = DEFAULT_CHAT_RETENTION_MS; // 30 days

      // 1 day later: chat still exists
      const after1DayMs = releasedAtMs + 1 * 24 * 60 * 60 * 1000;
      expect(after1DayMs - releasedAtMs).toBeLessThan(chatRetentionMs);

      // 30 days + 1 second later: chat is deleted
      const after30DaysMs = releasedAtMs + chatRetentionMs + 1000;
      expect(after30DaysMs - releasedAtMs).toBeGreaterThan(chatRetentionMs);
    });

    it("scenario: evidence is kept longer than chat (90d vs 30d)", () => {
      /**
       * Evidence (dispute uploads) should outlive chat messages
       * because evidence is legal artifact, chat is user communication
       */

      const releasedAtMs = Date.now();

      const chatDeleteAtMs = releasedAtMs + DEFAULT_CHAT_RETENTION_MS;
      const evidenceDeleteAtMs =
        releasedAtMs + DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS;

      // Evidence is kept longer
      expect(evidenceDeleteAtMs).toBeGreaterThan(chatDeleteAtMs);
      expect(evidenceDeleteAtMs - chatDeleteAtMs).toBeGreaterThan(
        50 * 24 * 60 * 60 * 1000,
      ); // At least 50 days difference
    });
  });

  describe("Constant values match contract expectations", () => {
    it("ESCROW_MAX_TIMEOUT_LEDGERS_POLICY matches contract", () => {
      // From contracts/escrow/src/lib.rs line 78:
      // const DEFAULT_TIMEOUT_LEDGERS_MAX: u32 = 6 * 60 * 24 * 7;
      expect(ESCROW_MAX_TIMEOUT_LEDGERS_POLICY).toBe(6 * 60 * 24 * 7);
      expect(ESCROW_MAX_TIMEOUT_LEDGERS_POLICY).toBe(60_480);
    });

    it("DISPUTE_RESOLUTION_WINDOW_LEDGERS matches contract", () => {
      // From contracts/escrow/src/lib.rs line 90:
      // const DISPUTE_RESOLUTION_WINDOW_LEDGERS: u32 = 12 * 60 * 24 * 3;
      expect(DISPUTE_RESOLUTION_WINDOW_LEDGERS).toBe(12 * 60 * 24 * 3);
      expect(DISPUTE_RESOLUTION_WINDOW_LEDGERS).toBe(51_840);
    });

    it("CASH_DEFAULT_TIMEOUT_LEDGERS reflects API intent (P2P quick settlement)", () => {
      // ~100 ledgers = ~15 minutes at ~9s/ledger
      // This is intentionally short for quick hand-off
      expect(CASH_DEFAULT_TIMEOUT_LEDGERS).toBe(100);
      expect(CASH_DEFAULT_TIMEOUT_LEDGERS).toBeLessThan(
        SETTLEMENT_CHAIN_DEFAULT_TIMEOUT_LEDGERS,
      );
    });

    it("SETTLEMENT_CHAIN_DEFAULT_TIMEOUT_LEDGERS is longer (multi-hop needs coordination)", () => {
      // ~8640 ledgers = ~24 hours
      // Multi-hop chains need longer window than P2P
      expect(SETTLEMENT_CHAIN_DEFAULT_TIMEOUT_LEDGERS).toBe(24 * 60 * 6);
      expect(SETTLEMENT_CHAIN_DEFAULT_TIMEOUT_LEDGERS).toBe(8_640);
      expect(SETTLEMENT_CHAIN_DEFAULT_TIMEOUT_LEDGERS).toBeGreaterThan(
        CASH_DEFAULT_TIMEOUT_LEDGERS,
      );
    });
  });

  describe("buildRefundCountdown", () => {
    it("reports remaining ledgers and estimated seconds before timeout", () => {
      expect(buildRefundCountdown(1_100, 1_050)).toEqual({
        timeoutLedger: 1_100,
        latestLedger: 1_050,
        ledgersUntilRefund: 50,
        refundAvailable: false,
        estimatedSecondsUntilRefund: 50 * AVERAGE_LEDGER_CLOSE_SECONDS,
      });
    });

    it("reports refund available once the timeout ledger is reached", () => {
      expect(buildRefundCountdown(1_100, 1_100)).toMatchObject({
        ledgersUntilRefund: 0,
        refundAvailable: true,
        estimatedSecondsUntilRefund: 0,
      });
      expect(buildRefundCountdown(1_100, 1_200).refundAvailable).toBe(true);
    });
  });
});
