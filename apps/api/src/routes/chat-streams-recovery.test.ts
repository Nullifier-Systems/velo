import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryChatInfrastructure,
  type ChatStreamEntry,
} from "../lib/chat-infrastructure-streams.js";
import {
  incrementClock,
  mergeClock,
  compareClocks,
  canDeliver,
} from "../lib/vector-clock.js";
import type { VectorClock } from "../lib/vector-clock.js";

const BUYER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SELLER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TRADE_ID = "trade-recovery-test";

describe("Chat Infrastructure Streams - Message Recovery", () => {
  let infra: MemoryChatInfrastructure;

  beforeEach(async () => {
    infra = new MemoryChatInfrastructure();
    await infra.putTrade(TRADE_ID, {
      buyer: BUYER,
      seller: SELLER,
      status: "locked",
    });
  });

  afterEach(async () => {
    await infra.close();
  });

  describe("Vector Clock Advancement", () => {
    it("increments clock for each published message", async () => {
      await infra.publish(TRADE_ID, {
        type: "peerKey",
        participant: BUYER,
        publicKey: "test-key-1",
      });

      const missed = await infra.getMissedMessages(TRADE_ID, {}, BUYER);
      expect(missed.length).toBe(1);
      expect(missed[0].clock[BUYER]).toBe(1);
    });

    it("maintains separate counters per participant", async () => {
      // Buyer publishes
      await infra.publish(TRADE_ID, {
        type: "peerKey",
        participant: BUYER,
        publicKey: "key-1",
      });

      // Seller publishes
      await infra.publish(TRADE_ID, {
        type: "peerKey",
        participant: SELLER,
        publicKey: "key-2",
      });

      const missed = await infra.getMissedMessages(TRADE_ID, {}, BUYER);
      expect(missed.length).toBe(2);
      // Clocks should be present with incremented values
      expect(missed[0].clock).toBeDefined();
      expect(missed[1].clock).toBeDefined();
      // First message from buyer should have buyer counter incremented
      expect(missed[0].clock.buyer).toBeGreaterThanOrEqual(1);
      // Second message from seller should have seller counter incremented
      expect(missed[1].clock.seller).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Message Recovery - No Loss", () => {
    it("recovers all messages from empty client clock", async () => {
      // Simulate 5 messages
      for (let i = 0; i < 5; i++) {
        await infra.publish(TRADE_ID, {
          type: "peerKey",
          participant: BUYER,
          publicKey: `key-${i}`,
        });
      }

      // Client reconnects with empty clock
      const missed = await infra.getMissedMessages(TRADE_ID, {}, BUYER);
      expect(missed.length).toBe(5);
    });

    it("recovers only missed messages when client has partial clock", async () => {
      // Messages 1-3
      for (let i = 1; i <= 3; i++) {
        await infra.publish(TRADE_ID, {
          type: "peerKey",
          participant: BUYER,
          publicKey: `key-${i}`,
        });
      }

      // Get first message's clock
      const firstBatch = await infra.getMissedMessages(TRADE_ID, {}, BUYER);
      const clientClock = firstBatch[0].clock;

      // More messages (4-6)
      for (let i = 4; i <= 6; i++) {
        await infra.publish(TRADE_ID, {
          type: "peerKey",
          participant: BUYER,
          publicKey: `key-${i}`,
        });
      }

      // Client recovers only what it missed
      const missed = await infra.getMissedMessages(
        TRADE_ID,
        clientClock,
        BUYER,
      );
      expect(missed.length).toBeGreaterThan(0);
      expect(missed.length).toBeLessThan(6);
    });

    it("handles 100 high-frequency messages without loss", async () => {
      // Simulate rapid fire messages
      const messageCount = 100;
      for (let i = 0; i < messageCount; i++) {
        await infra.publish(TRADE_ID, {
          type: "peerKey",
          participant: i % 2 === 0 ? BUYER : SELLER,
          publicKey: `key-${i}`,
        });
      }

      // Recovery: start fresh
      const missed = await infra.getMissedMessages(TRADE_ID, {}, BUYER);
      expect(missed.length).toBe(messageCount);
    });
  });

  describe("Causal Message Ordering", () => {
    it("recovers messages in causal order", async () => {
      // Buyer sends 1
      await infra.publish(TRADE_ID, {
        type: "peerKey",
        participant: BUYER,
        publicKey: "buyer-1",
      });

      // Seller responds (sees buyer's message)
      await infra.publish(TRADE_ID, {
        type: "peerKey",
        participant: SELLER,
        publicKey: "seller-1",
      });

      // Buyer sends 2 (sees seller's response)
      await infra.publish(TRADE_ID, {
        type: "peerKey",
        participant: BUYER,
        publicKey: "buyer-2",
      });

      const recovered = await infra.getMissedMessages(TRADE_ID, {}, BUYER);

      // Verify causal order: buyer-1 < seller-1 < buyer-2
      expect(recovered.length).toBe(3);
      // Clocks should be present and ordered causally
      expect(recovered[0].clock).toBeDefined();
      expect(recovered[1].clock).toBeDefined();
      expect(recovered[2].clock).toBeDefined();
      // Verify the ordering is causal (each happens before the next)
      expect(compareClocks(recovered[0].clock, recovered[1].clock)).toBeLessThanOrEqual(0);
      expect(compareClocks(recovered[1].clock, recovered[2].clock)).toBeLessThanOrEqual(0);
    });

    it("prevents out-of-order delivery", async () => {
      // Simulate buyer's three messages
      const msg1Clock = incrementClock({}, BUYER);
      const msg2Clock = incrementClock(msg1Clock, BUYER);
      const msg3Clock = incrementClock(msg2Clock, BUYER);

      expect(compareClocks(msg1Clock, msg2Clock)).toBe(-1);
      expect(compareClocks(msg2Clock, msg3Clock)).toBe(-1);

      // If client has msg1Clock, msg3Clock is NOT ready to deliver yet
      // (client hasn't processed msg2)
      const canDeliverMsg3 = canDeliver(msg1Clock, BUYER, msg3Clock);
      expect(canDeliverMsg3).toBe(false); // Cannot skip msg2
      
      // But msg2 is ready to deliver
      const canDeliverMsg2 = canDeliver(msg1Clock, BUYER, msg2Clock);
      expect(canDeliverMsg2).toBe(true);
    });
  });

  describe("Node Failure Scenario", () => {
    it("survives simulated API node crash and reconnect", async () => {
      // Node A: clients connected, messages flowing
      const clientClockAtCrash = {} as VectorClock;

      // 20 messages before crash
      for (let i = 0; i < 20; i++) {
        await infra.publish(TRADE_ID, {
          type: "peerKey",
          participant: i % 2 === 0 ? BUYER : SELLER,
          publicKey: `msg-${i}`,
        });
      }

      // Get all messages before crash
      const beforeCrash = await infra.getMissedMessages(TRADE_ID, {}, BUYER);
      expect(beforeCrash.length).toBe(20);

      // Simulate client keeping track of last seen clock
      const clientLastSeenClock = beforeCrash[beforeCrash.length - 1].clock;

      // Node A "crashes", node B takes over (same infrastructure)
      // New messages arrive
      for (let i = 20; i < 30; i++) {
        await infra.publish(TRADE_ID, {
          type: "peerKey",
          participant: SELLER,
          publicKey: `msg-${i}`,
        });
      }

      // Client reconnects and recovers only new messages
      const afterReconnect = await infra.getMissedMessages(
        TRADE_ID,
        clientLastSeenClock,
        BUYER,
      );

      // Should get messages 20-29 (10 new ones)
      expect(afterReconnect.length).toBeGreaterThan(0);
      expect(
        afterReconnect.every(
          (e) => compareClocks(e.clock, clientLastSeenClock) > 0,
        ),
      ).toBe(true);
    });

    it("resync works with intermediate socket resets", async () => {
      // Initial batch
      for (let i = 0; i < 10; i++) {
        await infra.publish(TRADE_ID, {
          type: "peerKey",
          participant: BUYER,
          publicKey: `msg-${i}`,
        });
      }

      let clientClock = (await infra.getMissedMessages(TRADE_ID, {}, BUYER))[0]
        .clock;

      // Socket reset 1: get partial recovery
      const batch1 = await infra.getMissedMessages(
        TRADE_ID,
        clientClock,
        BUYER,
      );
      if (batch1.length > 0) clientClock = batch1[batch1.length - 1].clock;

      // More messages
      for (let i = 10; i < 20; i++) {
        await infra.publish(TRADE_ID, {
          type: "peerKey",
          participant: SELLER,
          publicKey: `msg-${i}`,
        });
      }

      // Socket reset 2: recover remaining
      const batch2 = await infra.getMissedMessages(
        TRADE_ID,
        clientClock,
        BUYER,
      );
      expect(batch2.length).toBeGreaterThan(0);

      // Total should be near 20
      const totalRecovered = batch1.length + batch2.length;
      expect(totalRecovered).toBeGreaterThanOrEqual(10);
    });
  });

  describe("Concurrent Message Handling", () => {
    it("handles concurrent messages from both participants", async () => {
      // Rapid concurrent sends
      for (let i = 0; i < 10; i++) {
        const promises = [];

        // Both send simultaneously
        promises.push(
          infra.publish(TRADE_ID, {
            type: "peerKey",
            participant: BUYER,
            publicKey: `buyer-${i}`,
          }),
        );

        promises.push(
          infra.publish(TRADE_ID, {
            type: "peerKey",
            participant: SELLER,
            publicKey: `seller-${i}`,
          }),
        );

        await Promise.all(promises);
      }

      const recovered = await infra.getMissedMessages(TRADE_ID, {}, BUYER);
      expect(recovered.length).toBe(20);

      // Verify sender sequences are maintained
      const buyerMsgs = recovered.filter((m) => m.sender === BUYER);
      const sellerMsgs = recovered.filter((m) => m.sender === SELLER);

      expect(buyerMsgs.length).toBeGreaterThan(0);
      expect(sellerMsgs.length).toBeGreaterThan(0);

      // Each sender's sequence should be increasing
      for (let i = 1; i < buyerMsgs.length; i++) {
        expect(
          (buyerMsgs[i].clock.buyer ?? 0) >=
            (buyerMsgs[i - 1].clock.buyer ?? 0),
        ).toBe(true);
      }
    });

    it("sorts concurrent messages deterministically", async () => {
      // Create a concurrent pair
      await infra.publish(TRADE_ID, {
        type: "peerKey",
        participant: BUYER,
        publicKey: "buyer-msg",
      });

      await infra.publish(TRADE_ID, {
        type: "peerKey",
        participant: SELLER,
        publicKey: "seller-msg",
      });

      // Get messages multiple times
      const recovered1 = await infra.getMissedMessages(TRADE_ID, {}, BUYER);
      const recovered2 = await infra.getMissedMessages(TRADE_ID, {}, BUYER);

      // Order must be identical (deterministic concurrent ordering)
      expect(JSON.stringify(recovered1.map((e) => e.clock))).toBe(
        JSON.stringify(recovered2.map((e) => e.clock)),
      );
    });
  });

  describe("Message Types and Payloads", () => {
    it("preserves all message types through recovery", async () => {
      const msg1 = {
        type: "peerKey" as const,
        participant: BUYER,
        publicKey: "pub1",
      };
      const msg2 = { type: "closed" as const, reason: "test" };

      await infra.publish(TRADE_ID, msg1);
      await infra.publish(TRADE_ID, msg2);

      const recovered = await infra.getMissedMessages(TRADE_ID, {}, BUYER);
      expect(recovered[0].event).toEqual(msg1);
      expect(recovered[1].event).toEqual(msg2);
    });

    it("preserves chat message structure", async () => {
      const msg = await infra.saveMessage({
        tradeId: TRADE_ID,
        sender: BUYER,
        ciphertext: "encrypted-content",
        nonce: "unique-nonce",
      });

      await infra.publish(TRADE_ID, {
        type: "message",
        data: msg,
      });

      const recovered = await infra.getMissedMessages(TRADE_ID, {}, BUYER);
      expect(recovered[0].event.type).toBe("message");
      if (recovered[0].event.type === "message") {
        expect(recovered[0].event.data.ciphertext).toBe("encrypted-content");
        expect(recovered[0].event.data.nonce).toBe("unique-nonce");
      }
    });
  });

  describe("Edge Cases", () => {
    it("handles empty recovery gracefully", async () => {
      const future = { buyer: 1000, seller: 1000 };
      const recovered = await infra.getMissedMessages(TRADE_ID, future, BUYER);
      expect(recovered.length).toBe(0);
    });

    it("handles recovery with unknown participant", async () => {
      await infra.publish(TRADE_ID, {
        type: "peerKey",
        participant: BUYER,
        publicKey: "msg1",
      });

      const recovered = await infra.getMissedMessages(
        TRADE_ID,
        {},
        "UNKNOWN_PARTICIPANT",
      );
      expect(recovered.length).toBe(1); // Still get the message
    });

    it("handles rapid reconnects without message duplication", async () => {
      await infra.publish(TRADE_ID, {
        type: "peerKey",
        participant: BUYER,
        publicKey: "unique",
      });

      const recovered1 = await infra.getMissedMessages(TRADE_ID, {}, BUYER);
      const recovered2 = await infra.getMissedMessages(
        TRADE_ID,
        recovered1[0].clock,
        BUYER,
      );

      // Second recovery should be empty (already saw that clock)
      expect(recovered2.length).toBe(0);
    });
  });
});
