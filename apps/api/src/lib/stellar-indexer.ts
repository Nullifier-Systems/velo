import type { Server } from "@stellar/stellar-sdk/rpc";
import type { FastifyBaseLogger } from "fastify";
import { decodeEscrowEvent, type IndexedEscrowEvent } from "./escrow-events.js";
import { escrowDeltaFeed } from "./escrow-deltas.js";
import type { EventStore } from "./stellar-event-store.js";

interface RpcEventsResponse {
  events?: any[];
  latestLedger?: number;
  cursor?: string;
}

export interface StellarIndexerOptions {
  contractId: string;
  startLedger?: number;
  pollIntervalMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  onTrace?: (point: StellarIndexerTracePoint) => void;
  /**
   * (#374) Formal invariant verification hook. Invoked after each committed
   * batch, once EventStore.process has durably indexed `throughLedger`. The
   * default wiring in index.ts reconciles the reconstructed contract totals
   * against the on-chain balance and trips the automated circuit breaker on a
   * VIOLATED verdict.
   */
  verify?: (throughLedger: number, events: IndexedEscrowEvent[]) => Promise<void>;
}

export type StellarIndexerTraceStage =
  | "get_events_request_started"
  | "get_events_response_received"
  | "event_decoding_completed"
  | "persistence_started"
  | "persistence_completed";

export interface StellarIndexerTracePoint {
  stage: StellarIndexerTraceStage;
  monotonicMs: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class StellarEscrowIndexer {
  private stopped = false;
  private retryMs: number;

  constructor(
    private readonly rpc: Pick<Server, "getEvents" | "getLatestLedger" | "getLedgers">,
    private readonly store: EventStore,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">,
    private readonly options: StellarIndexerOptions,
  ) {
    this.retryMs = options.retryMinMs ?? 250;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    this.stopped = false;
    this.logger.info({ contractId: this.options.contractId }, "stellar escrow indexer started");
    while (!this.stopped) {
      try {
        await this.pollOnce();
        this.retryMs = this.options.retryMinMs ?? 250;
        await wait(this.options.pollIntervalMs ?? 1000);
      } catch (error) {
        this.logger.warn({ err: error, retryMs: this.retryMs }, "stellar RPC/database unavailable; retry scheduled");
        await wait(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, this.options.retryMaxMs ?? 30_000);
      }
    }
  }

  async pollOnce(): Promise<number> {
    const checkpoint = await this.store.checkpoint();
    let startLedger: number;
    let knownStartHash: string | undefined;
    if (checkpoint) {
      startLedger = checkpoint.ledger + 1;
    } else if (this.options.startLedger !== undefined) {
      startLedger = this.options.startLedger;
    } else {
      const initial = await this.rpc.getLatestLedger();
      startLedger = initial.sequence;
      knownStartHash = initial.id;
    }

    if (checkpoint?.validationLedger !== undefined && checkpoint.validationHash) {
      const currentHash = await this.ledgerHash(checkpoint.validationLedger);
      if (currentHash !== checkpoint.validationHash) {
        this.logger.warn(
          { ledger: checkpoint.validationLedger },
          "stored ledger event history differs from RPC; recovery started",
        );
        await this.recover();
        return 0;
      }
    }

    this.trace("get_events_request_started");
    const response = await this.fetchResponse(startLedger);
    this.trace("get_events_response_received");
    const events = this.decode(response.events ?? []);
    this.trace("event_decoding_completed");
    const throughLedger = response.latestLedger ?? startLedger;
    const ledgerHash = knownStartHash && throughLedger === startLedger
      ? knownStartHash
      : await this.ledgerHash(throughLedger);
    this.trace("persistence_started");
    const deltas = await this.store.process(events, throughLedger, ledgerHash);
    this.trace("persistence_completed");
    // Publishing happens only after EventStore.process has committed.
    for (const item of deltas) escrowDeltaFeed.publish(item);
    if (events.length) {
      this.logger.info({ throughLedger, eventCount: events.length }, "stellar ledger batch indexed");
    }
    // (#374) Invariant verification runs after the batch is durably indexed —
    // a VIOLATED verdict flips the contract to HALTED via the circuit breaker.
    if (this.options.verify) {
      await this.options.verify(throughLedger, events);
    }
    return events.length;
  }

  private decode(rawEvents: any[]): IndexedEscrowEvent[] {
    return rawEvents
      .map((event, order) => decodeEscrowEvent(event, order))
      .filter((event): event is IndexedEscrowEvent => event !== null)
      .sort((a, b) => a.ledger - b.ledger || a.order - b.order);
  }

  private async fetchResponse(startLedger: number): Promise<RpcEventsResponse> {
    const all: any[] = [];
    let cursor: string | undefined;
    let latestLedger: number | undefined;
    let hasMore = true;
    while (hasMore) {
      const request = cursor
        ? {
            cursor,
            filters: [{ type: "contract", contractIds: [this.options.contractId] }],
            limit: 10_000,
          }
        : {
            startLedger,
            filters: [{ type: "contract", contractIds: [this.options.contractId] }],
            limit: 10_000,
          };
      const response = await this.rpc.getEvents(request as never) as RpcEventsResponse;
      const page = response.events ?? [];
      all.push(...page);
      latestLedger = response.latestLedger ?? latestLedger;
      cursor = response.cursor;
      hasMore = page.length === 10_000 && Boolean(cursor);
    }
    return { events: all, latestLedger };
  }

  private async recover(): Promise<void> {
    const fingerprints = await this.store.fingerprints();
    let validLedger = Math.max(0, (this.options.startLedger ?? 1) - 1);
    for (const fingerprint of fingerprints) {
      const current = await this.ledgerHash(fingerprint.ledger);
      if (current === fingerprint.hash) {
        validLedger = fingerprint.ledger;
        break;
      }
    }
    this.logger.warn({ validLedger }, "rolling back invalid indexed history");
    await this.store.rollbackAfter(validLedger);
    this.logger.info({ validLedger }, "index rollback completed; indexing will resume");
  }

  private async ledgerHash(sequence: number): Promise<string> {
    const response = await this.rpc.getLedgers({
      startLedger: sequence,
      pagination: { limit: 1 },
    });
    const ledger = response.ledgers.find((item) => item.sequence === sequence);
    if (!ledger) throw new Error(`RPC did not return ledger ${sequence}`);
    return ledger.hash;
  }

  private trace(stage: StellarIndexerTraceStage): void {
    this.options.onTrace?.({ stage, monotonicMs: performance.now() });
  }
}
