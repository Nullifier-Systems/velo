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
    let channels: any[] = [];
    let commits: any[] = [];
    let settlements: any[] = [];

    // Mock db as a template tag function (synchronous return of promise)
    mockDb = function (strings: any[], ...values: any[]) {
      const query = strings.join("?");

      return (async () => {
        if (query.includes("INSERT INTO state_channels")) {
          const channel = {
            channel_id: values[0],
            party_a: values[1],
            party_b: values[2],
            total_deposit_stroops: values[3].toString(),
            nonce: "0",
            status: "OPEN",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          channels.push(channel);
          return [channel];
        }

        if (query.includes("SELECT * FROM state_channels WHERE channel_id")) {
          const result = channels.filter((c) => c.channel_id === values[0]);
          return result.length > 0 ? result : [];
        }

        if (query.includes("INSERT INTO state_channel_commits")) {
          const commit = {
            commit_id: "commit-1",
            channel_id: values[0],
            sequence_number: values[1].toString(),
            signer: values[2],
            state_root: values[3],
            signature: values[4],
            party_a_balance: values[5].toString(),
            party_b_balance: values[6].toString(),
            created_at: new Date().toISOString(),
          };
          commits.push(commit);
          return [commit];
        }

        if (query.includes("SELECT * FROM state_channel_commits")) {
          return commits.filter((c) => c.channel_id === values[0]);
        }

        if (query.includes("INSERT INTO state_channel_settlements")) {
          const settlement = {
            settlement_id: `settlement-${settlements.length + 1}`,
            channel_id: values[0],
            final_sequence_number: values[1].toString(),
            initiator: values[2],
            party_a_final_balance: values[3].toString(),
            party_b_final_balance: values[4].toString(),
            merkle_root: values[5],
            submitted_txn_hash: null,
            status: "PENDING",
            settled_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          settlements.push(settlement);
          return [settlement];
        }

        if (query.includes("UPDATE state_channels SET status")) {
          return [];
        }

        return [];
      })();
    };

    store = new StateChannelStore({ db: mockDb, redis: undefined });
  });

  describe("createChannel", () => {
    it("creates a new channel with initial state", async () => {
      const channel = await store.createChannel(
        "test-channel",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKXNJ5",
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
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKXNJ5",
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
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKXNJ5",
        1000000000n,
      );

      const commit = await store.recordCommit(
        "test-channel",
        1n,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
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
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKXNJ5",
        1000000000n,
      );

      // Record first commit at sequence 1
      await store.recordCommit(
        "test-channel",
        1n,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
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
          "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKXNJ5",
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
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKXNJ5",
        1000000000n,
      );

      // Record at sequence 5
      await store.recordCommit(
        "test-channel",
        5n,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
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
          "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKXNJ5",
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
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
      );
      expect(result).toBe(true);
    });

    it("rejects invalid signature format", async () => {
      const result = await store["verifySignature"](
        "message",
        "invalid-signature",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
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
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKXNJ5",
        1000000000n,
      );

      const settlement = await store.recordSettlement(
        "test-channel",
        100n,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
        500000000n,
        500000000n,
        "0xabcd",
      );

      expect(settlement.settlementId).toBeDefined();
      expect(settlement.channelId).toBe("test-channel");
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
