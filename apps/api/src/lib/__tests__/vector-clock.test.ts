/**
 * Vector Clock Tests
 * Ensuring total ordering and causality of state channel commits.
 */

import { describe, it, expect } from "vitest";
import {
  createVectorClock,
  isValidVectorClockAdvance,
  advanceVectorClock,
} from "../vector-clock.js";

describe("Vector Clock", () => {
  describe("createVectorClock", () => {
    it("initializes with zero sequence and empty signer", () => {
      const clock = createVectorClock("channel-1");

      expect(clock.channelId).toBe("channel-1");
      expect(clock.lastSequence).toBe(0n);
      expect(clock.lastSigner).toBe("");
    });
  });

  describe("isValidVectorClockAdvance", () => {
    it("rejects advance with wrong channel ID", () => {
      const clock = createVectorClock("channel-1");

      const valid = isValidVectorClockAdvance(
        clock,
        1n,
        "signer-1",
        "channel-2" // Wrong channel
      );

      expect(valid).toBe(false);
    });

    it("rejects stale sequence (equal to last)", () => {
      const clock = createVectorClock("channel-1");
      const advanced = advanceVectorClock(clock, 5n, "signer-1");

      const valid = isValidVectorClockAdvance(
        advanced,
        5n, // Same as lastSequence
        "signer-2",
        "channel-1"
      );

      expect(valid).toBe(false);
    });

    it("rejects backward sequence (less than last)", () => {
      const clock = createVectorClock("channel-1");
      const advanced = advanceVectorClock(clock, 10n, "signer-1");

      const valid = isValidVectorClockAdvance(
        advanced,
        5n, // Less than lastSequence (10)
        "signer-2",
        "channel-1"
      );

      expect(valid).toBe(false);
    });

    it("accepts forward sequence (greater than last)", () => {
      const clock = createVectorClock("channel-1");
      const advanced = advanceVectorClock(clock, 5n, "signer-1");

      const valid = isValidVectorClockAdvance(
        advanced,
        6n, // Greater than lastSequence (5)
        "signer-2",
        "channel-1"
      );

      expect(valid).toBe(true);
    });

    it("accepts first sequence (0 -> 1)", () => {
      const clock = createVectorClock("channel-1");

      const valid = isValidVectorClockAdvance(
        clock,
        1n, // First valid sequence
        "signer-1",
        "channel-1"
      );

      expect(valid).toBe(true);
    });

    it("accepts large sequence jumps", () => {
      const clock = createVectorClock("channel-1");
      const advanced = advanceVectorClock(clock, 1n, "signer-1");

      const valid = isValidVectorClockAdvance(
        advanced,
        1000000n, // Large jump
        "signer-1",
        "channel-1"
      );

      expect(valid).toBe(true);
    });
  });

  describe("advanceVectorClock", () => {
    it("updates sequence and signer", () => {
      const clock = createVectorClock("channel-1");

      const advanced = advanceVectorClock(clock, 5n, "signer-1");

      expect(advanced.lastSequence).toBe(5n);
      expect(advanced.lastSigner).toBe("signer-1");
      expect(advanced.channelId).toBe("channel-1");
    });

    it("allows sequence changes from same signer", () => {
      const clock = createVectorClock("channel-1");
      const first = advanceVectorClock(clock, 1n, "signer-1");
      const second = advanceVectorClock(first, 2n, "signer-1");
      const third = advanceVectorClock(second, 3n, "signer-1");

      expect(third.lastSequence).toBe(3n);
      expect(third.lastSigner).toBe("signer-1");
    });

    it("allows sequence changes from different signers", () => {
      const clock = createVectorClock("channel-1");
      const first = advanceVectorClock(clock, 1n, "signer-1");
      const second = advanceVectorClock(first, 2n, "signer-2");

      expect(second.lastSequence).toBe(2n);
      expect(second.lastSigner).toBe("signer-2");
    });

    it("does not mutate original clock", () => {
      const clock = createVectorClock("channel-1");
      const original = { ...clock };

      advanceVectorClock(clock, 5n, "signer-1");

      expect(clock).toEqual(original);
    });
  });

  describe("vector clock invariants", () => {
    it("enforces total ordering across multiple signers", () => {
      let clock = createVectorClock("channel-1");

      // Party A signs at sequence 1
      expect(
        isValidVectorClockAdvance(clock, 1n, "party-a", "channel-1")
      ).toBe(true);
      clock = advanceVectorClock(clock, 1n, "party-a");

      // Party B signs at sequence 2 (must increment)
      expect(
        isValidVectorClockAdvance(clock, 2n, "party-b", "channel-1")
      ).toBe(true);
      clock = advanceVectorClock(clock, 2n, "party-b");

      // Party A signs at sequence 3 (must continue incrementing)
      expect(
        isValidVectorClockAdvance(clock, 3n, "party-a", "channel-1")
      ).toBe(true);
      clock = advanceVectorClock(clock, 3n, "party-a");

      // Party B cannot go back to 2
      expect(
        isValidVectorClockAdvance(clock, 2n, "party-b", "channel-1")
      ).toBe(false);

      // Party A cannot replay at 1
      expect(
        isValidVectorClockAdvance(clock, 1n, "party-a", "channel-1")
      ).toBe(false);
    });

    it("prevents replay attacks", () => {
      let clock = createVectorClock("channel-1");

      // First signature at sequence 100
      expect(
        isValidVectorClockAdvance(clock, 100n, "party-a", "channel-1")
      ).toBe(true);
      clock = advanceVectorClock(clock, 100n, "party-a");

      // Replay of the same update (sequence 100) is rejected
      expect(
        isValidVectorClockAdvance(clock, 100n, "party-a", "channel-1")
      ).toBe(false);

      // Even from a different party, 100 is stale
      expect(
        isValidVectorClockAdvance(clock, 100n, "party-b", "channel-1")
      ).toBe(false);

      // Only 101 or higher is accepted
      expect(
        isValidVectorClockAdvance(clock, 101n, "party-b", "channel-1")
      ).toBe(true);
    });
  });
});
