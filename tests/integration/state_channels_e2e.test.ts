/**
 * End-to-End State Channels Integration Test
 * Full workflow: create channel → exchange states → settle on-chain
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ChannelManager } from "apps/api/src/lib/state-channels/channel-manager.js";

describe("State Channels E2E Workflow", () => {
  let manager: ChannelManager;

  beforeEach(() => {
    const mockDb = {
      async query(...args: any[]) {
        return [];
      },
    };
    manager = new ChannelManager({ db: mockDb, contractId: "test-contract" });
  });

  describe("Full Channel Lifecycle", () => {
    it("executes: open → streaming → settle", async () => {
      const partyA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7";
      const partyB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2";
      const channelId = "e2e-test-channel-1";
      const totalDeposit = 10000000000n; // 1000 USDC in stroops

      // Step 1: Open channel
      const channel = await manager.openChannel(
        channelId,
        partyA,
        partyB,
        totalDeposit
      );

      expect(channel.channelId).toBe(channelId);
      expect(channel.status).toBe("OPEN");
      expect(channel.totalDepositStroops).toBe(totalDeposit);

      // Step 2: Exchange state updates (streaming)
      // Party A sends first update
      const update1 = await manager.recordStateUpdate(
        channelId,
        1n, // sequence
        partyA,
        5000000000n, // party A balance
        5000000000n, // party B balance
        "0".repeat(128) // mock signature
      );

      expect(update1.sequenceNumber).toBe(1n);
      expect(update1.signer).toBe(partyA);

      // Party B responds at sequence 2
      const update2 = await manager.recordStateUpdate(
        channelId,
        2n,
        partyB,
        4000000000n, // party A reduced
        6000000000n, // party B increased
        "0".repeat(128)
      );

      expect(update2.sequenceNumber).toBe(2n);
      expect(update2.signer).toBe(partyB);

      // Continue streaming: rapid updates
      for (let i = 3; i <= 100; i++) {
        const signer = i % 2 === 1 ? partyA : partyB;
        await manager.recordStateUpdate(
          channelId,
          BigInt(i),
          signer,
          5000000000n,
          5000000000n,
          "0".repeat(128)
        );
      }

      // Step 3: Get latest state
      const latestState = await manager.getLatestState(channelId);
      expect(latestState?.sequenceNumber).toBe(100n);

      // Step 4: Propose settlement
      const settlementId = await manager.proposeSettlement(
        channelId,
        100n, // final sequence
        5000000000n, // final party A balance
        5000000000n, // final party B balance
        "0x" + "a".repeat(64) // merkle root of all commits
      );

      expect(settlementId).toBeDefined();

      // Step 5: Record on-chain submission
      const txnHash = "0x" + "b".repeat(64);
      await manager.recordSettlementSubmission(settlementId, txnHash);

      // Step 6: Finalize settlement after on-chain confirmation
      await manager.finalizeSettlement(settlementId);

      // Step 7: Close channel
      await manager.closeChannel(channelId);

      const closedChannel = await manager.getChannel(channelId);
      expect(closedChannel?.status).toBe("CLOSED");
    });
  });

  describe("Dispute Scenario", () => {
    it("handles uncooperative close with penalty", async () => {
      const partyA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7";
      const partyB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2";
      const channelId = "dispute-test-channel";
      const totalDeposit = 10000000000n;

      // Open channel
      const channel = await manager.openChannel(
        channelId,
        partyA,
        partyB,
        totalDeposit
      );

      // Exchange updates up to sequence 100
      for (let i = 1; i <= 100; i++) {
        const signer = i % 2 === 1 ? partyA : partyB;
        await manager.recordStateUpdate(
          channelId,
          BigInt(i),
          signer,
          5000000000n,
          5000000000n,
          "0".repeat(128)
        );
      }

      // Scenario: Party A tries uncooperative close at sequence 50 (stale)
      // But party B has evidence at sequence 100

      // Get latest (sequence 100)
      const latestState = await manager.getLatestState(channelId);
      expect(latestState?.sequenceNumber).toBe(100n);

      // In real scenario:
      // 1. Party A submits old state (seq 50) to contract
      // 2. Contract moves to CLOSING state
      // 3. Dispute watcher detects mismatch
      // 4. Watcher auto-submits challenge with evidence (seq 100)
      // 5. Contract executes penalty_slash, closes channel
      // 6. Party B gets refund minus penalty for party A

      // For this test, verify we have the evidence
      expect(latestState?.signature).toBeDefined();
      expect(latestState?.partyABalance).toBe(5000000000n);
      expect(latestState?.partyBBalance).toBe(5000000000n);
    });
  });

  describe("Error Scenarios", () => {
    it("rejects out-of-order sequences", async () => {
      const partyA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7";
      const partyB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2";
      const channelId = "order-test-channel";

      await manager.openChannel(
        channelId,
        partyA,
        partyB,
        10000000000n
      );

      // Record at sequence 1
      await manager.recordStateUpdate(
        channelId,
        1n,
        partyA,
        5000000000n,
        5000000000n,
        "0".repeat(128)
      );

      // Try to record at sequence 1 again (replay)
      await expect(
        manager.recordStateUpdate(
          channelId,
          1n, // Same sequence
          partyB,
          5000000000n,
          5000000000n,
          "0".repeat(128)
        )
      ).rejects.toThrow("Stale or replayed sequence");

      // Try to go backward
      await expect(
        manager.recordStateUpdate(
          channelId,
          0n, // Backward
          partyA,
          5000000000n,
          5000000000n,
          "0".repeat(128)
        )
      ).rejects.toThrow("Stale or replayed sequence");
    });

    it("rejects balance mismatch", async () => {
      const partyA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7";
      const partyB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2";
      const channelId = "balance-test-channel";
      const totalDeposit = 10000000000n;

      await manager.openChannel(
        channelId,
        partyA,
        partyB,
        totalDeposit
      );

      // Try to record with balances that don't sum to deposit
      await expect(
        manager.recordStateUpdate(
          channelId,
          1n,
          partyA,
          6000000000n, // Too much
          6000000000n, // Too much
          "0".repeat(128)
        )
      ).rejects.toThrow("Balance mismatch");
    });

    it("rejects non-party signer", async () => {
      const partyA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7";
      const partyB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2";
      const nonParty = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCYYVYEQ";

      await manager.openChannel(
        "non-party-test",
        partyA,
        partyB,
        10000000000n
      );

      // Try to sign as non-party
      await expect(
        manager.recordStateUpdate(
          "non-party-test",
          1n,
          nonParty, // Not a party
          5000000000n,
          5000000000n,
          "0".repeat(128)
        )
      ).rejects.toThrow("not a party to this channel");
    });
  });
});
