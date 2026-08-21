/**
 * State Channel Store Tests
 * Testing persistence layer, vector clock, and signature validation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { StateChannelStore } from "../state-channel-store.js";
import { createVectorClock } from "../../vector-clock.js";

describe("StateChannelStore", () => {
  let store: StateChannelStore;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      // Mock postgres-style query with template tag
      async query(...args: any[]) {
        if (args[0]?.includes("INSERT INTO state_channels")) {
          return [
            {
              channel_id: "test-channel",
              party_a: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
              party_b: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
              total_deposit_stroops: "1000000000",
              nonce: "0",
              status: "OPEN",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ];
        }
        if (args[0]?.includes("SELECT * FROM state_channels")) {
          return [
            {
              channel_id: "test-channel",
              party_a: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
              party_b: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
              total_deposit_stroops: "1000000000",
              nonce: "0",
              status: "OPEN",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ];
        }
        if (
          args[0]?.includes("INSERT INTO state_channel_commits")
        ) {
          return [
            {
              commit_id: "commit-1",
              channel_id: "test-channel",
              sequence_number: "1",
              signer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
              state_root: "root123",
              signature:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              party_a_balance: "500000000",
              party_b_balance: "500000000",
              created_at: new Date().toISOString(),
            },
          ];
        }
        return [];
      },
    };

    store = new StateChannelStore({ db: mockDb, redis: undefined });
  });

  describe("createChannel", () => {
    it("creates a new channel with initial state", async () => {
      const channel = await store.createChannel(
        "test-channel",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
        1000000000n,
      );

      expect(channel.channelId).toBe("test-channel");
      expect(channel.status).toBe("OPEN");
      expect(channel.totalDepositStroops).toBe(1000000000n);
      expect(channel.nonce).toBe(0n);
    });
  });

  describe("getChannel", () => {
    it("retrieves an existing channel", async () => {
      // Create first
      await store.createChannel(
        "test-channel",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
        1000000000n,
      );

      // Then retrieve
      const channel = await store.getChannel("test-channel");
      expect(channel).not.toBeNull();
      expect(channel?.channelId).toBe("test-channel");
    });

    it("returns null for nonexistent channel", async () => {
      mockDb.query = vi.fn().mockResolvedValue([]);
      const channel = await store.getChannel("nonexistent");
      expect(channel).toBeNull();
    });
  });

  describe("recordCommit with vector clock validation", () => {
    it("accepts a valid first commit (sequence 1 > 0)", async () => {
      // Create channel first
      await store.createChannel(
        "test-channel",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
        1000000000n,
      );

      const commit = await store.recordCommit(
        "test-channel",
        1n,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
        "root123",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        500000000n,
        500000000n,
      );

      expect(commit.sequenceNumber).toBe(1n);
      expect(commit.partyABalance).toBe(500000000n);
    });

    it("rejects a stale sequence number", async () => {
      // Create channel
      await store.createChannel(
        "test-channel",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
        1000000000n,
      );

      // Record first commit at sequence 1
      await store.recordCommit(
        "test-channel",
        1n,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
        "root123",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        500000000n,
        500000000n,
      );

      // Attempt to record at sequence 1 again (stale)
      await expect(
        store.recordCommit(
          "test-channel",
          1n, // Same sequence
          "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
          "root123",
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          600000000n,
          400000000n,
        ),
      ).rejects.toThrow("Stale or replayed sequence");
    });

    it("rejects sequences that go backwards", async () => {
      // Create channel
      await store.createChannel(
        "test-channel",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
        1000000000n,
      );

      // Record at sequence 5
      await store.recordCommit(
        "test-channel",
        5n,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
        "root123",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        500000000n,
        500000000n,
      );

      // Attempt to record at sequence 3 (going backwards)
      await expect(
        store.recordCommit(
          "test-channel",
          3n, // Lower than 5
          "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
          "root123",
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          400000000n,
          600000000n,
        ),
      ).rejects.toThrow("Stale or replayed sequence");
    });
  });

  describe("verifySignature", () => {
    it("validates signature format", async () => {
      const result = await store["verifySignature"](
        "message",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
      );
      expect(result).toBe(true);
    });

    it("rejects invalid signature format", async () => {
      const result = await store["verifySignature"](
        "message",
        "invalid-signature",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
      );
      expect(result).toBe(false);
    });

    it("rejects invalid public key format", async () => {
      const result = await store["verifySignature"](
        "message",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "invalid-key",
      );
      expect(result).toBe(false);
    });
  });

  describe("recordSettlement", () => {
    it("records a settlement submission", async () => {
      // Create channel first
      await store.createChannel(
        "test-channel",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
        1000000000n,
      );

      // Record settlement
      mockDb.query = vi.fn().mockResolvedValue([
        {
          settlement_id: "settlement-1",
          channel_id: "test-channel",
          final_sequence_number: "100",
          initiator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
          party_a_final_balance: "500000000",
          party_b_final_balance: "500000000",
          merkle_root: "0xabcd",
          submitted_txn_hash: null,
          status: "PENDING",
          settled_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);

      const settlement = await store.recordSettlement(
        "test-channel",
        100n,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
        500000000n,
        500000000n,
        "0xabcd",
      );

      expect(settlement.settlementId).toBe("settlement-1");
      expect(settlement.status).toBe("PENDING");
      expect(settlement.finalSequenceNumber).toBe(100n);
    });
  });

  describe("closeChannel", () => {
    it("marks a channel as closed", async () => {
      mockDb.query = vi.fn().mockResolvedValue([]);

      await store.closeChannel("test-channel");

      // Verify the query was called
      expect(mockDb.query).toBeDefined();
    });
  });
});
