import { describe, expect, it, vi } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { StellarEscrowIndexer } from "./stellar-indexer.js";
import type { IndexedEscrowEvent } from "./escrow-events.js";
import type { EscrowDelta } from "./escrow-deltas.js";
import type { EventStore, IndexerCheckpoint } from "./stellar-event-store.js";
import { escrowDeltaFeed } from "./escrow-deltas.js";

const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const trade = new Uint8Array(32).fill(7);

function raw(kind: "locked" | "released" | "disputed", ledger: number, id: string) {
  return {
    id,
    contractId,
    ledger,
    topic: [nativeToScVal(kind, { type: "symbol" }), nativeToScVal(trade)],
    value: nativeToScVal(kind === "disputed" ? ["GBUYER"] : 100n),
  };
}

class MemoryEventStore implements EventStore {
  progress: IndexerCheckpoint | null = null;
  events = new Map<string, IndexedEscrowEvent>();
  state: EscrowDelta | null = null;
  failNext = false;
  history = new Map<number, string>();

  async checkpoint() { return this.progress; }
  async process(events: IndexedEscrowEvent[], throughLedger: number, hash?: string) {
    if (this.failNext) { this.failNext = false; throw new Error("database unavailable"); }
    const changes: EscrowDelta[] = [];
    for (const event of events) {
      if (this.events.has(event.eventId)) continue;
      this.events.set(event.eventId, event);
      this.state = {
        contractId: event.contractId, escrowId: event.escrowId, status: event.type,
        lockedAmount: event.type === "locked" ? event.amount ?? null : this.state?.lockedAmount ?? null,
        releasedAmount: event.type === "released" ? event.amount ?? null : null,
        disputedBy: event.actor ?? null, lastLedger: event.ledger,
      };
      changes.push(this.state);
    }
    const validationLedger = hash ? throughLedger : this.progress?.validationLedger;
    if (validationLedger !== undefined && hash) this.history.set(validationLedger, hash);
    this.progress = {
      ledger: throughLedger, validationLedger,
      validationHash: hash ?? this.progress?.validationHash,
    };
    return changes;
  }
  async fingerprints() {
    return [...this.history].sort((a, b) => b[0] - a[0]).map(([ledger, hash]) => ({ ledger, hash }));
  }
  async rollbackAfter(ledger: number) {
    for (const [id, event] of this.events) if (event.ledger > ledger) this.events.delete(id);
    this.progress = { ledger };
    this.state = null;
  }
  async escrow() { return this.state; }
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const getLedgers = vi.fn(async ({ startLedger }: { startLedger: number }) => ({
  ledgers: [{ sequence: startLedger, hash: `hash-${startLedger}` }],
}));

describe("StellarEscrowIndexer recovery", () => {
  it("survives an RPC disconnect and resumes without duplicates", async () => {
    const store = new MemoryEventStore();
    const getEvents = vi.fn()
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValue({
        events: [raw("locked", 10, "a"), raw("released", 10, "b")],
        latestLedger: 10,
      });
    const worker = new StellarEscrowIndexer(
      { getEvents, getLatestLedger: vi.fn(), getLedgers } as any, store, logger as any,
      { contractId, startLedger: 10 },
    );
    await expect(worker.pollOnce()).rejects.toThrow("disconnected");
    expect(store.progress).toBeNull();
    await expect(worker.pollOnce()).resolves.toBe(2);
    await worker.pollOnce();
    expect(store.events.size).toBe(2);
    expect(store.progress?.ledger).toBe(10);
    expect(store.state?.status).toBe("released");
  });

  it("does not advance on database failover and replays idempotently after recovery", async () => {
    const store = new MemoryEventStore();
    store.failNext = true;
    const getEvents = vi.fn().mockResolvedValue({
      events: [raw("locked", 10, "a")], latestLedger: 10,
    });
    const worker = new StellarEscrowIndexer(
      { getEvents, getLatestLedger: vi.fn(), getLedgers } as any, store, logger as any,
      { contractId, startLedger: 10 },
    );
    let notifications = 0;
    const unsubscribe = escrowDeltaFeed.subscribe(contractId, "07".repeat(32), () => notifications++);
    await expect(worker.pollOnce()).rejects.toThrow("database unavailable");
    expect(store.progress).toBeNull();
    expect(notifications).toBe(0);
    await worker.pollOnce();
    await worker.pollOnce();
    expect(store.events.size).toBe(1);
    expect(store.progress?.ledger).toBe(10);
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("does not fetch an unused latest ledger when a checkpoint exists", async () => {
    const store = new MemoryEventStore();
    store.progress = {
      ledger: 9,
      validationLedger: 9,
      validationHash: "hash-9",
    };
    const getLatestLedger = vi.fn();
    const getEvents = vi.fn().mockResolvedValue({
      events: [raw("locked", 10, "a")],
      latestLedger: 10,
    });
    const getLedgerHashes = vi.fn(async ({ startLedger }: { startLedger: number }) => ({
      ledgers: [{ sequence: startLedger, hash: `hash-${startLedger}` }],
    }));
    const worker = new StellarEscrowIndexer(
      { getEvents, getLatestLedger, getLedgers: getLedgerHashes } as any,
      store,
      logger as any,
      { contractId },
    );

    await expect(worker.pollOnce()).resolves.toBe(1);
    expect(getLatestLedger).not.toHaveBeenCalled();
    expect(getLedgerHashes.mock.calls.map(([request]) => request.startLedger).sort((a, b) => a - b))
      .toEqual([9, 10]);
  });

  it("reuses the initial latest-ledger hash when no checkpoint exists", async () => {
    const store = new MemoryEventStore();
    const getLatestLedger = vi.fn().mockResolvedValue({
      sequence: 10,
      id: "hash-10",
    });
    const getLedgerHashes = vi.fn();
    const worker = new StellarEscrowIndexer(
      {
        getLatestLedger,
        getEvents: vi.fn().mockResolvedValue({
          events: [raw("locked", 10, "a")],
          latestLedger: 10,
        }),
        getLedgers: getLedgerHashes,
      } as any,
      store,
      logger as any,
      { contractId },
    );

    await expect(worker.pollOnce()).resolves.toBe(1);
    expect(getLatestLedger).toHaveBeenCalledOnce();
    expect(getLedgerHashes).not.toHaveBeenCalled();
    expect(store.progress?.validationHash).toBe("hash-10");
  });

  it("detects invalid ledger history, rolls back, and resumes", async () => {
    const store = new MemoryEventStore();
    const original = raw("locked", 10, "old");
    const decoded = (await import("./escrow-events.js")).decodeEscrowEvent(original, 0)!;
    store.events.set(decoded.eventId, decoded);
    store.history.set(10, "old-hash");
    store.progress = { ledger: 10, validationLedger: 10, validationHash: "old-hash" };
    const replacement = raw("locked", 10, "new");
    const getEvents = vi.fn().mockResolvedValue({ events: [replacement], latestLedger: 10 });
    const worker = new StellarEscrowIndexer(
      {
        getEvents,
        getLatestLedger: vi.fn(),
        getLedgers: vi.fn(async ({ startLedger }: { startLedger: number }) => ({
          ledgers: [{ sequence: startLedger, hash: startLedger === 10 ? "new-hash" : `hash-${startLedger}` }],
        })),
      } as any, store, logger as any,
      { contractId, startLedger: 10 },
    );
    await worker.pollOnce();
    expect(store.progress?.ledger).toBe(9);
    expect(store.events.size).toBe(0);
    await worker.pollOnce();
    expect(store.events.size).toBe(1);
  });
});
