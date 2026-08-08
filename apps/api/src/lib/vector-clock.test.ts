import { describe, expect, it } from "vitest";
import {
  incrementClock,
  mergeClock,
  happensBefore,
  areConcurrent,
  compareClocks,
  canDeliver,
  normalizeClock,
  type VectorClock,
} from "./vector-clock.js";

describe("Vector Clock Operations", () => {
  describe("incrementClock", () => {
    it("increments the participant's counter", () => {
      const clock = { buyer: 5, seller: 3 };
      const result = incrementClock(clock, "buyer");
      expect(result).toEqual({ buyer: 6, seller: 3 });
    });

    it("adds participant if not present", () => {
      const clock = { buyer: 2 };
      const result = incrementClock(clock, "seller");
      expect(result).toEqual({ buyer: 2, seller: 1 });
    });

    it("does not mutate original clock", () => {
      const clock = { buyer: 2 };
      incrementClock(clock, "buyer");
      expect(clock).toEqual({ buyer: 2 }); // unchanged
    });
  });

  describe("mergeClock", () => {
    it("takes componentwise maximum", () => {
      const local = { buyer: 5, seller: 2 };
      const received = { buyer: 3, seller: 4 };
      const result = mergeClock(local, received);
      expect(result).toEqual({ buyer: 5, seller: 4 });
    });

    it("preserves keys from both clocks", () => {
      const local = { buyer: 2 };
      const received = { seller: 3 };
      const result = mergeClock(local, received);
      expect(result).toEqual({ buyer: 2, seller: 3 });
    });

    it("handles empty clocks", () => {
      expect(mergeClock({}, { buyer: 1 })).toEqual({ buyer: 1 });
      expect(mergeClock({ buyer: 1 }, {})).toEqual({ buyer: 1 });
    });
  });

  describe("happensBefore", () => {
    it("detects v1 < v2 strictly", () => {
      const v1 = { buyer: 2, seller: 1 };
      const v2 = { buyer: 3, seller: 2 };
      expect(happensBefore(v1, v2)).toBe(true);
    });

    it("rejects v1 > v2 in any component", () => {
      const v1 = { buyer: 5, seller: 1 };
      const v2 = { buyer: 3, seller: 2 };
      expect(happensBefore(v1, v2)).toBe(false);
    });

    it("rejects identical clocks (must have strict inequality)", () => {
      const v1 = { buyer: 2, seller: 1 };
      const v2 = { buyer: 2, seller: 1 };
      expect(happensBefore(v1, v2)).toBe(false);
    });

    it("handles missing keys as 0", () => {
      const v1 = { buyer: 1 };
      const v2 = { buyer: 2, seller: 1 };
      expect(happensBefore(v1, v2)).toBe(true); // buyer: 1 < 2, seller: 0 < 1
    });
  });

  describe("areConcurrent", () => {
    it("detects concurrent events", () => {
      const v1 = { buyer: 5, seller: 1 };
      const v2 = { buyer: 2, seller: 3 };
      expect(areConcurrent(v1, v2)).toBe(true);
    });

    it("rejects causally related events", () => {
      const v1 = { buyer: 2, seller: 1 };
      const v2 = { buyer: 3, seller: 2 };
      expect(areConcurrent(v1, v2)).toBe(false);
    });

    it("rejects identical clocks", () => {
      const v1 = { buyer: 2, seller: 1 };
      const v2 = { buyer: 2, seller: 1 };
      expect(areConcurrent(v1, v2)).toBe(false);
    });
  });

  describe("compareClocks", () => {
    it("returns -1 if v1 happens-before v2", () => {
      const v1 = { buyer: 1, seller: 1 };
      const v2 = { buyer: 2, seller: 1 };
      expect(compareClocks(v1, v2)).toBe(-1);
    });

    it("returns 1 if v2 happens-before v1", () => {
      const v1 = { buyer: 2, seller: 1 };
      const v2 = { buyer: 1, seller: 1 };
      expect(compareClocks(v1, v2)).toBe(1);
    });

    it("returns 0 if clocks are identical", () => {
      const v1 = { buyer: 2, seller: 1 };
      const v2 = { buyer: 2, seller: 1 };
      expect(compareClocks(v1, v2)).toBe(0);
    });

    it("uses deterministic ordering for concurrent clocks", () => {
      const v1 = { buyer: 2, seller: 1 };
      const v2 = { buyer: 1, seller: 2 };
      // Concurrent, so order by JSON
      const result = compareClocks(v1, v2);
      expect([-1, 1]).toContain(result);
      expect(compareClocks(v1, v2)).toBe(compareClocks(v1, v2)); // Consistent
    });
  });

  describe("canDeliver", () => {
    it("allows delivery when sender incremented exactly once", () => {
      const local = { buyer: 5, seller: 3 };
      const messageClock = { buyer: 6, seller: 3 }; // buyer incremented from 5 to 6
      expect(canDeliver(local, "buyer", messageClock)).toBe(true);
    });

    it("blocks delivery when sender skipped increments", () => {
      const local = { buyer: 5, seller: 3 };
      const messageClock = { buyer: 7, seller: 3 }; // buyer jumped from 5 to 7
      expect(canDeliver(local, "buyer", messageClock)).toBe(false);
    });

    it("blocks delivery when other participants advanced ahead", () => {
      const local = { buyer: 5, seller: 3 };
      const messageClock = { buyer: 6, seller: 5 }; // seller jumped ahead
      expect(canDeliver(local, "buyer", messageClock)).toBe(false);
    });

    it("blocks delivery when sender not incremented", () => {
      const local = { buyer: 5, seller: 3 };
      const messageClock = { buyer: 5, seller: 3 }; // no increment
      expect(canDeliver(local, "buyer", messageClock)).toBe(false);
    });

    it("allows new participant first message", () => {
      const local = { buyer: 5 };
      const messageClock = { buyer: 5, seller: 1 }; // seller's first message
      expect(canDeliver(local, "seller", messageClock)).toBe(true);
    });
  });

  describe("normalizeClock", () => {
    it("adds 0 entries for missing participants", () => {
      const clock = { buyer: 2 };
      const result = normalizeClock(clock, ["buyer", "seller", "system"]);
      expect(result).toEqual({ buyer: 2, seller: 0, system: 0 });
    });

    it("preserves existing values", () => {
      const clock = { buyer: 2, seller: 1 };
      const result = normalizeClock(clock, ["buyer", "seller"]);
      expect(result).toEqual({ buyer: 2, seller: 1 });
    });

    it("does not remove extra keys", () => {
      const clock = { buyer: 2, seller: 1 };
      const result = normalizeClock(clock, ["buyer"]);
      expect(result).toEqual({ buyer: 2, seller: 1 });
    });
  });

  describe("Message Ordering Scenarios", () => {
    it("orders messages from same sender sequentially", () => {
      const msg1 = { buyer: 1, seller: 0 };
      const msg2 = { buyer: 2, seller: 0 };
      const msg3 = { buyer: 3, seller: 0 };

      expect(compareClocks(msg1, msg2)).toBe(-1);
      expect(compareClocks(msg2, msg3)).toBe(-1);
      expect(compareClocks(msg1, msg3)).toBe(-1);
    });

    it("handles interleaved messages", () => {
      // Buyer sends, seller responds, buyer sends again
      const buyerMsg1 = { buyer: 1, seller: 0 };
      const sellerMsg1 = { buyer: 1, seller: 1 }; // After seeing buyer's msg1
      const buyerMsg2 = { buyer: 2, seller: 1 }; // After seeing seller's msg1

      expect(happensBefore(buyerMsg1, sellerMsg1)).toBe(true);
      expect(happensBefore(sellerMsg1, buyerMsg2)).toBe(true);
      expect(happensBefore(buyerMsg1, buyerMsg2)).toBe(true);
    });

    it("detects message loss", () => {
      // Client last saw buyer:5, seller:3
      // Receives buyer:7 (buyer incremented by 2, which should be impossible)
      const local = { buyer: 5, seller: 3 };
      const messageClock = { buyer: 7, seller: 3 };
      expect(canDeliver(local, "buyer", messageClock)).toBe(false); // Missing message!
    });
  });

  describe("High-Concurrency Scenario", () => {
    it("recovers causal order from 100 interleaved messages", () => {
      // Simulate rapid concurrent sends
      const clocks: Array<[string, VectorClock]> = [];
      let buyerCount = 0;
      let sellerCount = 0;

      for (let i = 0; i < 100; i++) {
        const sender = i % 2 === 0 ? "buyer" : "seller";
        if (sender === "buyer") buyerCount++;
        else sellerCount++;

        const clock: VectorClock = { buyer: buyerCount, seller: sellerCount };
        clocks.push([JSON.stringify(clock), clock]);
      }

      // Shuffle them
      const shuffled = [...clocks].sort(() => Math.random() - 0.5);

      // Parse back and verify they can be re-sorted
      const parsed = shuffled.map(
        ([json]) => JSON.parse(json) as VectorClock,
      );
      const resorted = parsed.sort(compareClocks);

      // Verify sender sequences are preserved (non-decreasing)
      const buyerSequence = resorted
        .filter((c) => c.buyer > 0)
        .map((c) => c.buyer);
      const sellerSequence = resorted
        .filter((c) => c.seller > 0)
        .map((c) => c.seller);

      // Check that sequences are non-decreasing
      for (let i = 1; i < buyerSequence.length; i++) {
        expect(buyerSequence[i]).toBeGreaterThanOrEqual(buyerSequence[i - 1]);
      }
      for (let i = 1; i < sellerSequence.length; i++) {
        expect(sellerSequence[i]).toBeGreaterThanOrEqual(sellerSequence[i - 1]);
      }
      
      // Check that we have the expected number of unique values
      const uniqueBuyerValues = new Set(buyerSequence);
      const uniqueSellerValues = new Set(sellerSequence);
      expect(uniqueBuyerValues.size).toBe(50); // 50 buyer messages
      expect(uniqueSellerValues.size).toBe(50); // 50 seller messages
    });
  });
});
