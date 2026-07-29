import { describe, it, expect, beforeEach } from "vitest";
import type { StoredMessage } from "../store";
import { createMessage, mergeMessages, compareMessages, mergeClock, resetClock, tickClock } from "../crdt";

describe("CRDT — Lamport clock", () => {
  beforeEach(() => resetClock());

  it("tickClock increments", () => {
    const a = tickClock();
    const b = tickClock();
    expect(b).toBe(a + 1);
  });

  it("mergeClock takes the max", () => {
    mergeClock(100);
    expect(tickClock()).toBe(101);
  });
});

describe("CRDT — compareMessages", () => {
  const base = () => createMessage("t1", "m1", "alice", "enc", "nonce", "client-a");

  beforeEach(() => resetClock());

  it("higher clock wins", () => {
    resetClock();
    const a = base();
    const b = { ...base(), clock: 999 };
    expect(compareMessages(a, b)).toBeLessThan(0);
  });

  it("same clock, higher clientId wins", () => {
    resetClock();
    const a = base();
    const b = { ...base(), clientId: "z" };
    expect(compareMessages(a, b)).toBeLessThan(0);
  });
});

describe("CRDT — mergeMessages", () => {
  beforeEach(() => resetClock());

  it("merges unique messages from both sides", () => {
    const local = [createMessage("t1", "m1", "a", "c1", "n1", "c1")];
    const remote = [createMessage("t1", "m2", "b", "c2", "n2", "c2")];
    const merged = mergeMessages(local, remote);
    expect(merged).toHaveLength(2);
  });

  it("deduplicates by messageId, keeping higher clock", () => {
    const local = [createMessage("t1", "m1", "a", "c1", "n1", "c1")];
    const remote = [{ ...local[0], clock: 999, ciphertext: "updated" } as any];
    const merged = mergeMessages(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].ciphertext).toBe("updated");
  });

  it("returns sorted by clock ascending", () => {
    const msgs = [tickClock() && createMessage("t1", "m1", "a", "c", "n", "a")].filter(Boolean) as StoredMessage[];
    resetClock();
    const msg1 = createMessage("t1", "m2", "b", "c", "n", "b");
    const msg2 = createMessage("t1", "m3", "c", "c", "n", "c");
    const merged = mergeMessages(msgs, [msg1, msg2]);
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i].clock).toBeGreaterThanOrEqual(merged[i - 1].clock);
    }
  });
});
