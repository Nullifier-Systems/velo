import { describe, expect, it, vi } from "vitest";
import { CIRCUIT_BREAKER } from "@velo/shared";
import {
  StellarIndexerWorker,
  type AdvisoryLock,
  type LedgerFrame,
} from "./stellarIndexerWorker.js";
import { CircuitBreakerStore } from "../circuit-breaker-store.js";

const CONTRACT = "C".padEnd(56, "a");

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Single shared election registry: only one FakeAdvisoryLock can hold it. */
class LockRegistry {
  private holderId: number | null = null;

  acquire(id: number): boolean {
    if (this.holderId !== null) return false;
    this.holderId = id;
    return true;
  }

  release(id: number): boolean {
    if (this.holderId === id) {
      this.holderId = null;
      return true;
    }
    return false;
  }
}

class FakeAdvisoryLock implements AdvisoryLock {
  constructor(
    private readonly registry: LockRegistry,
    private readonly id: number,
  ) {}

  async acquire(): Promise<boolean> {
    return this.registry.acquire(this.id);
  }

  async release(): Promise<void> {
    this.registry.release(this.id);
  }
}

function idleStream() {
  return {
    latestLedger: vi.fn(async () => 0),
    next: vi.fn(async () => ({ frames: [], latestLedger: 0 })),
  };
}

describe("StellarIndexerWorker single-leader election (#374)", () => {
  it("keeps exactly one leader among concurrently starting workers", async () => {
    const registry = new LockRegistry();
    const leadershipEvents: Array<{ id: number; leader: boolean }> = [];

    const workers = [0, 1, 2].map((id) => {
      const store = new CircuitBreakerStore();
      const worker = new StellarIndexerWorker({
        contractId: CONTRACT,
        rpc: {} as any,
        store: { process: vi.fn(async () => []) } as any,
        stateStore: store,
        lock: new FakeAdvisoryLock(registry, id),
        stream: idleStream(),
        logger: logger as any,
        startLedger: 1,
        pollIntervalMs: 5,
        onLeadershipChange: (leader) => leadershipEvents.push({ id, leader }),
      });
      return { id, worker, store };
    });

    const starts = workers.map(({ worker }) => worker.start());

    // Sample the leadership set while all three contend for the lock.
    let sawLeader = false;
    for (let sample = 0; sample < 30; sample++) {
      const leaders = workers.filter(({ worker }) => worker.isLeader);
      expect(leaders.length).toBeLessThanOrEqual(1);
      if (leaders.length === 1) sawLeader = true;
      await wait(5);
    }

    expect(sawLeader).toBe(true);
    expect(leadershipEvents.some((event) => event.leader)).toBe(true);

    // Handoff: stopping the current leader lets another standby take over.
    const currentLeader = workers.find(({ worker }) => worker.isLeader);
    if (currentLeader) {
      await currentLeader.worker.stop();
      await wait(50);
      const newLeader = workers.find(({ worker }) => worker.isLeader);
      expect(newLeader).toBeDefined();
      expect(newLeader!.id).not.toBe(currentLeader.id);
    }

    await Promise.all(workers.map(({ worker }) => worker.stop()));
    await Promise.all(starts);
    expect(workers.filter(({ worker }) => worker.isLeader)).toHaveLength(0);
  });

  it("never allows two leaders even under rapid stop/start churn", async () => {
    const registry = new LockRegistry();
    const workers = [0, 1, 2].map((id) => {
      const worker = new StellarIndexerWorker({
        contractId: CONTRACT,
        rpc: {} as any,
        store: { process: vi.fn(async () => []) } as any,
        stateStore: new CircuitBreakerStore(),
        lock: new FakeAdvisoryLock(registry, id),
        stream: idleStream(),
        logger: logger as any,
        startLedger: 1,
        pollIntervalMs: 2,
      });
      return { id, worker };
    });

    const starts = workers.map(({ worker }) => worker.start());

    // Aggressive stop/start churn of random workers.
    for (let round = 0; round < 10; round++) {
      const target = workers[round % workers.length];
      await target.worker.stop();
      target.worker.start();
      await wait(3);
      const leaders = workers.filter(({ worker }) => worker.isLeader);
      expect(leaders.length).toBeLessThanOrEqual(1);
    }

    await Promise.all(workers.map(({ worker }) => worker.stop()));
    await Promise.all(starts);
    expect(workers.filter(({ worker }) => worker.isLeader)).toHaveLength(0);
  });
});

describe("StellarIndexerWorker circuit-breaker pause SLA (#374)", () => {
  function frame(ledger: number): LedgerFrame {
    return { source: "rpc-a", ledger, clock: { "rpc-a": ledger }, events: [] };
  }

  it("trips the breaker and halts the contract within the SLA deadline", async () => {
    const store = new CircuitBreakerStore();
    const startedAt = Date.now();
    const trigger = vi.fn(async () => {
      await wait(10);
      return { hash: "tx-pause-1" };
    });
    // On-chain balance reads 1000 stroops with zero expected reserve → VIOLATED.
    const readActualBalance = vi
      .fn()
      .mockResolvedValueOnce(1000n)
      .mockResolvedValue(null);

    const worker = new StellarIndexerWorker({
      contractId: CONTRACT,
      rpc: {} as any,
      store: { process: vi.fn(async () => []) } as any,
      stateStore: store,
      lock: new FakeAdvisoryLock(new LockRegistry(), 1),
      stream: {
        latestLedger: vi.fn(async () => 101),
        next: vi
          .fn()
          .mockResolvedValueOnce({ frames: [frame(101)], latestLedger: 101 })
          .mockResolvedValue({ frames: [], latestLedger: 0 }),
      },
      logger: logger as any,
      startLedger: 100,
      pollIntervalMs: 5,
      readActualBalance,
      triggerCircuitBreaker: trigger,
    });

    const start = worker.start();

    let status: string | null = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      status = (await store.get(CONTRACT))?.status ?? null;
      if (status === "HALTED") break;
      await wait(5);
    }

    expect(status).toBe("HALTED");
    expect(trigger).toHaveBeenCalled();

    const incidents = await store.incidents(CONTRACT);
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents[0].violatedInvariant).toBe("INV-07_RESERVE_CONSERVATION");
    expect(incidents[0].actionTaken).toBe("PAUSE_SINGLE_ESCROW");
    expect(incidents[0].txPauseHash).toBe("tx-pause-1");

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(CIRCUIT_BREAKER.PAUSE_TRIGGER_DEADLINE_MS);

    await worker.stop();
    await start;
  });

  it("records a NO_ACTION incident when the broadcast misses the SLA deadline", async () => {
    const store = new CircuitBreakerStore();
    const trigger = vi.fn(() => new Promise<{ hash: string }>(() => undefined));
    const readActualBalance = vi
      .fn()
      .mockResolvedValueOnce(1000n)
      .mockResolvedValue(null);

    const worker = new StellarIndexerWorker({
      contractId: CONTRACT,
      rpc: {} as any,
      store: { process: vi.fn(async () => []) } as any,
      stateStore: store,
      lock: new FakeAdvisoryLock(new LockRegistry(), 1),
      stream: {
        latestLedger: vi.fn(async () => 101),
        next: vi
          .fn()
          .mockResolvedValueOnce({ frames: [frame(101)], latestLedger: 101 })
          .mockResolvedValue({ frames: [], latestLedger: 0 }),
      },
      logger: logger as any,
      startLedger: 100,
      pollIntervalMs: 5,
      readActualBalance,
      triggerCircuitBreaker: trigger,
    });

    const start = worker.start();

    let incident: { actionTaken: string } | null = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const incidents = await store.incidents(CONTRACT);
      if (incidents.some((item) => item.actionTaken === "NO_ACTION")) {
        incident = incidents.find((item) => item.actionTaken === "NO_ACTION")!;
        break;
      }
      await wait(10);
    }

    expect(incident).toBeDefined();
    expect(incident!.actionTaken).toBe("NO_ACTION");

    await worker.stop();
    await start;
  });
});
