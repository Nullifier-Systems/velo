import { readFile } from "node:fs/promises";
import { createServer, connect, type Server as NetServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { Server as RpcServer } from "@stellar/stellar-sdk/rpc";
import { CONTRACTS } from "@velo/shared";
import type { IndexedEscrowEvent } from "./escrow-events.js";
import { PostgresEventStore } from "./stellar-event-store.js";
import { StellarEscrowIndexer } from "./stellar-indexer.js";

const databaseUrl = process.env.POSTGRES_INTEGRATION_URL;

function indexedEvent(sequence: number, type: "locked" | "released", index = 0): IndexedEscrowEvent {
  return {
    eventId: `integration-${sequence}-${index}`,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    ledger: sequence,
    order: index,
    transactionHash: `${sequence}-${index}`.padEnd(64, "0"),
    type,
    escrowId: index.toString(16).padStart(64, "0"),
    amount: type === "locked" ? "1000" : "975",
    raw: { integration: true, sequence, index },
  };
}

describe.skipIf(!databaseUrl)("PostgresEventStore real PostgreSQL integration", () => {
  const schema = `stellar_indexer_${process.pid}_${Date.now()}`;
  const scopedOptions = `-c search_path=${schema}`;
  let admin: Pool;
  let pool: Pool;
  let proxy: NetServer;
  let proxyPort: number;
  const sockets = new Set<Socket>();
  const target = new URL(databaseUrl ?? "postgresql://integration-not-configured");

  const startProxy = async (port = 0) => {
    proxy = createServer((client) => {
      const upstream = connect({
        host: target.hostname,
        port: Number(target.port || 5432),
      });
      sockets.add(client);
      sockets.add(upstream);
      const cleanup = () => {
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.once("close", cleanup);
      upstream.once("close", cleanup);
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(port, "127.0.0.1", resolve);
    });
    proxyPort = (proxy.address() as AddressInfo).port;
  };

  const stopProxy = async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  };

  const proxiedUrl = () => {
    const value = new URL(databaseUrl!);
    value.hostname = "127.0.0.1";
    value.port = String(proxyPort);
    return value.toString();
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await startProxy();
    pool = new Pool({ connectionString: proxiedUrl(), options: scopedOptions });
    const migrationPath = fileURLToPath(
      new URL("../../db/migrations/009_create_stellar_event_index.sql", import.meta.url),
    );
    await pool.query(await readFile(migrationPath, "utf8"));
  }, 30_000);

  afterAll(async () => {
    try {
      await pool?.end().catch(() => {});
      if (proxy?.listening) await stopProxy();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    } catch {
      // Cleanup is best effort; the dedicated test schema is disposable.
    }
  });

  it("applies migration 009 on PostgreSQL 17", async () => {
    const result = await pool.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname=$1 ORDER BY tablename`,
      [schema],
    );
    expect(result.rows.map((row) => row.tablename)).toEqual([
      "indexed_escrows",
      "stellar_canonical_events",
      "stellar_contract_events",
      "stellar_indexer_checkpoints",
      "stellar_ledger_fingerprints",
    ]);
  });

  it("keeps checkpoint N during a real outage and advances after PostgreSQL restarts", async () => {
    const store = new PostgresEventStore(pool, "failover-test");
    await store.process([indexedEvent(10, "locked")], 10, "hash-10");
    expect(await store.checkpoint()).toMatchObject({ ledger: 10, validationHash: "hash-10" });

    await pool.end();
    const port = proxyPort;
    await stopProxy();
    const unavailablePool = new Pool({
      connectionString: proxiedUrl(),
      options: scopedOptions,
      connectionTimeoutMillis: 500,
    });
    const unavailableStore = new PostgresEventStore(unavailablePool, "failover-test");
    await expect(
      unavailableStore.process([indexedEvent(11, "released")], 11, "hash-11"),
    ).rejects.toThrow();
    await unavailablePool.end();

    await startProxy(port);
    pool = new Pool({ connectionString: proxiedUrl(), options: scopedOptions });
    const recovered = new PostgresEventStore(pool, "failover-test");
    expect(await recovered.checkpoint()).toMatchObject({ ledger: 10, validationHash: "hash-10" });
    await recovered.process([indexedEvent(11, "released")], 11, "hash-11");
    expect(await recovered.checkpoint()).toMatchObject({ ledger: 11, validationHash: "hash-11" });
    expect(await recovered.escrow(indexedEvent(11, "released").contractId, "00".repeat(32)))
      .toMatchObject({ status: "released", lastLedger: 11 });
  }, 30_000);

  it("keeps historical event rows immutable across rollback and replacement", async () => {
    const store = new PostgresEventStore(pool, "append-only-test");
    const original = indexedEvent(20, "locked", 20);
    await store.process([original], 20, "old-ledger-hash");
    await store.rollbackAfter(19);

    const afterRollback = await pool.query(
      `SELECT
         (SELECT count(*) FROM stellar_contract_events WHERE event_id=$1) AS history_count,
         (SELECT count(*) FROM stellar_canonical_events WHERE event_id=$1) AS canonical_count`,
      [original.eventId],
    );
    expect(afterRollback.rows[0]).toMatchObject({
      history_count: "1",
      canonical_count: "0",
    });

    const replacement: IndexedEscrowEvent = {
      ...original,
      transactionHash: "replacement".padEnd(64, "0"),
      type: "released",
      amount: "975",
      raw: { integration: true, replacement: true },
    };
    await store.process([replacement], 20, "replacement-ledger-hash");
    const afterReplacement = await pool.query(
      `SELECT
         (SELECT count(*) FROM stellar_contract_events WHERE event_id=$1) AS history_count,
         (SELECT count(*) FROM stellar_canonical_events WHERE event_id=$1) AS canonical_count`,
      [original.eventId],
    );
    expect(afterReplacement.rows[0]).toMatchObject({
      history_count: "2",
      canonical_count: "1",
    });
    expect(await store.escrow(replacement.contractId, replacement.escrowId))
      .toMatchObject({ status: "released", lastLedger: 20 });
  });

  it("measures the complete PostgreSQL insert, projection and checkpoint transaction", async () => {
    const eventCount = 5_000;
    const events = Array.from({ length: eventCount }, (_, index) =>
      indexedEvent(1_000, "locked", index + 1),
    );
    const store = new PostgresEventStore(pool, "throughput-test");
    const started = performance.now();
    await store.process(events, 1_000, "hash-1000");
    const elapsedMs = performance.now() - started;
    const eventsPerSecond = eventCount / (elapsedMs / 1_000);
    console.info(
      `PostgreSQL persistence throughput: ${eventsPerSecond.toFixed(0)} events/sec (${elapsedMs.toFixed(1)} ms)`,
    );
    expect(eventsPerSecond).toBeGreaterThan(500);
  }, 30_000);

  it("measures commit latency after an event is already available", async () => {
    const store = new PostgresEventStore(pool, "commit-latency-test");
    const samples: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      const started = performance.now();
      await store.process([indexedEvent(2_000 + index, "locked", 6_000 + index)], 2_000 + index, `hash-${index}`);
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    console.info(
      `PostgreSQL post-availability commit latency: p50=${p50.toFixed(2)} ms p95=${p95.toFixed(2)} ms`,
    );
    expect(p50).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(process.env.STELLAR_LIVE_ACCEPTANCE !== "1")(
    "traces live Stellar ledger availability through PostgreSQL COMMIT",
    async () => {
      const rpc = new RpcServer(
        process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
      );
      const initial = await rpc.getLatestLedger();
      const seedStore = new PostgresEventStore(pool, "live-confirmation-latency-test");
      await seedStore.process([], initial.sequence, initial.id);

      type Trace = {
        ledgerObservedAt: number;
        ledgerObservedSequence: number;
        indexer: Partial<Record<string, number>>;
        database: Partial<Record<string, number>>;
        rpcCalls: Array<{
          method: string;
          startedAt: number;
          receivedAt: number;
          latestLedger?: number;
          eventCount?: number;
          closeTime?: string;
        }>;
      };
      let activeTrace: Trace | undefined;
      const tracedCall = async <T>(
        method: string,
        call: () => Promise<T>,
      ): Promise<T> => {
        const startedAt = performance.now();
        const response = await call();
        const receivedAt = performance.now();
        if (activeTrace) {
          const value = response as any;
          activeTrace.rpcCalls.push({
            method,
            startedAt,
            receivedAt,
            latestLedger: value.latestLedger ?? value.sequence,
            eventCount: value.events?.length,
            closeTime: value.latestLedgerCloseTime ?? value.closeTime,
          });
        }
        return response;
      };
      const tracedRpc = {
        getLatestLedger: () => tracedCall("getLatestLedger", () => rpc.getLatestLedger()),
        getEvents: (request: any) => tracedCall("getEvents", () => rpc.getEvents(request)),
        getLedgers: (request: any) => tracedCall(
          `getLedgers:${request.startLedger}`,
          () => rpc.getLedgers(request),
        ),
      };
      const store = new PostgresEventStore(
        pool,
        "live-confirmation-latency-test",
        (point) => {
          if (activeTrace) activeTrace.database[point.stage] = point.monotonicMs;
        },
      );
      const worker = new StellarEscrowIndexer(
        tracedRpc as any,
        store,
        { info() {}, warn() {}, error() {} } as any,
        {
          contractId: process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow,
          onTrace: (point) => {
            if (activeTrace) activeTrace.indexer[point.stage] = point.monotonicMs;
          },
        },
      );
      const metrics: Record<string, number[]> = {
        close_to_ledger_rpc_observable: [],
        ledger_rpc_observable_to_get_events_start: [],
        get_events_round_trip: [],
        close_to_event_rpc_observable: [],
        get_events_response_to_decode_complete: [],
        decode_complete_to_transaction_start: [],
        transaction_start_to_commit: [],
        event_rpc_observable_to_commit: [],
        close_to_commit: [],
        redundant_get_latest_ledger: [],
        checkpoint_validation_get_ledgers: [],
        through_ledger_hash_get_ledgers: [],
      };
      let observedEventCount = 0;
      let previous = initial.sequence;
      const sampleCount = Number(process.env.STELLAR_LATENCY_SAMPLES ?? 10);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        let observed = await rpc.getLatestLedger();
        let ledgerObservedAt = performance.now();
        while (observed.sequence <= previous) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          observed = await rpc.getLatestLedger();
          ledgerObservedAt = performance.now();
        }

        activeTrace = {
          ledgerObservedAt,
          ledgerObservedSequence: observed.sequence,
          indexer: {},
          database: {},
          rpcCalls: [],
        };
        observedEventCount += await worker.pollOnce();
        const checkpoint = await store.checkpoint();
        if (!checkpoint) throw new Error("live indexer did not persist its checkpoint");
        const trace = activeTrace;
        activeTrace = undefined;
        const getEvents = trace.rpcCalls.find((call) => call.method === "getEvents");
        const getLedgers = trace.rpcCalls.filter((call) => call.method.startsWith("getLedgers:"));
        const internalLatest = trace.rpcCalls.find((call) => call.method === "getLatestLedger");
        if (!getEvents) throw new Error("live trace did not record getEvents");
        const throughHash = getLedgers.at(-1);
        const rawCloseTime = getEvents.closeTime ?? throughHash?.closeTime;
        if (!rawCloseTime) throw new Error("live trace did not expose the ledger close time");
        const numericCloseTime = Number(rawCloseTime);
        const closeTimeMs = Number.isFinite(numericCloseTime)
          ? numericCloseTime * 1_000
          : Date.parse(rawCloseTime);
        const closeMonotonicMs = closeTimeMs - performance.timeOrigin;
        const getEventsStarted = trace.indexer.get_events_request_started!;
        const getEventsReceived = trace.indexer.get_events_response_received!;
        const decodingCompleted = trace.indexer.event_decoding_completed!;
        const transactionStarted = trace.database.transaction_started!;
        const transactionCommitted = trace.database.transaction_committed!;
        if (trace.ledgerObservedSequence === checkpoint.ledger) {
          metrics.close_to_ledger_rpc_observable.push(trace.ledgerObservedAt - closeMonotonicMs);
          metrics.ledger_rpc_observable_to_get_events_start.push(getEventsStarted - trace.ledgerObservedAt);
        }
        metrics.get_events_round_trip.push(getEventsReceived - getEventsStarted);
        metrics.close_to_event_rpc_observable.push(getEventsReceived - closeMonotonicMs);
        metrics.get_events_response_to_decode_complete.push(decodingCompleted - getEventsReceived);
        metrics.decode_complete_to_transaction_start.push(transactionStarted - decodingCompleted);
        metrics.transaction_start_to_commit.push(transactionCommitted - transactionStarted);
        metrics.event_rpc_observable_to_commit.push(transactionCommitted - getEventsReceived);
        metrics.close_to_commit.push(transactionCommitted - closeMonotonicMs);
        if (internalLatest) {
          metrics.redundant_get_latest_ledger.push(internalLatest.receivedAt - internalLatest.startedAt);
        }
        const validationHashCall = getLedgers.find((call) => call.method === `getLedgers:${previous}`);
        if (validationHashCall) {
          metrics.checkpoint_validation_get_ledgers.push(
            validationHashCall.receivedAt - validationHashCall.startedAt,
          );
        }
        const throughHashCall = getLedgers.find(
          (call) => call.method === `getLedgers:${checkpoint.ledger}`,
        );
        if (throughHashCall) {
          metrics.through_ledger_hash_get_ledgers.push(
            throughHashCall.receivedAt - throughHashCall.startedAt,
          );
        }
        previous = checkpoint.ledger;
      }

      const summaries = Object.fromEntries(
        Object.entries(metrics)
          .filter(([, samples]) => samples.length > 0)
          .map(([name, samples]) => {
            samples.sort((left, right) => left - right);
            return [name, {
              samples: samples.length,
              p50Ms: Number(samples[Math.floor(samples.length * 0.5)].toFixed(2)),
              p95Ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(2)),
            }];
          }),
      );
      console.info(
        `Live Stellar latency trace (${process.env.STELLAR_LATENCY_LABEL ?? "current"}): `
        + `${JSON.stringify(summaries)}; Velo events=${observedEventCount}`,
      );
      expect(metrics.close_to_commit.every(Number.isFinite)).toBe(true);
    },
    180_000,
  );
});
