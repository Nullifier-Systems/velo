import { expect, it } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { StellarEscrowIndexer } from "./stellar-indexer.js";
import type { EventStore } from "./stellar-event-store.js";

it("processes a 2,000-event RPC batch above 500 events/sec before PostgreSQL I/O", async () => {
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const topic = nativeToScVal("locked", { type: "symbol" });
  const events = Array.from({ length: 2_000 }, (_, index) => ({
    id: `event-${index}`,
    contractId,
    ledger: 100 + Math.floor(index / 100),
    topic: [topic, nativeToScVal(new Uint8Array(32).fill(index % 256))],
    value: nativeToScVal(100n),
  }));
  const store: EventStore = {
    checkpoint: async () => null,
    process: async (batch) => batch.map((event) => ({
      contractId: event.contractId, escrowId: event.escrowId, status: event.type,
      lockedAmount: event.amount ?? null, releasedAmount: null, disputedBy: null,
      lastLedger: event.ledger,
    })),
    fingerprints: async () => [],
    rollbackAfter: async () => {},
    escrow: async () => null,
  };
  const worker = new StellarEscrowIndexer(
    {
      getLatestLedger: async () => ({ sequence: 100 }),
      getEvents: async () => ({ events, latestLedger: 120 }),
      getLedgers: async () => ({ ledgers: [{ sequence: 120, hash: "hash-120" }] }),
    } as any,
    store,
    { info() {}, warn() {}, error() {} } as any,
    { contractId, startLedger: 100 },
  );
  const started = performance.now();
  const count = await worker.pollOnce();
  const elapsedMs = performance.now() - started;
  const eventsPerSecond = count / (elapsedMs / 1000);
  console.info(`indexer pre-DB throughput: ${eventsPerSecond.toFixed(0)} events/sec (${elapsedMs.toFixed(1)} ms)`);
  expect(count).toBe(2_000);
  expect(eventsPerSecond).toBeGreaterThan(500);
});
