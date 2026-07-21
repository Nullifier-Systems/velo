import { scValToNative, xdr } from '@stellar/stellar-sdk';
import type { Server } from '@stellar/stellar-sdk/rpc';

/** A decoded `released` event from the Soroban atomic-swap contract. */
export interface ReleasedEvent {
  /** The swap/trade id, hex (no 0x prefix), matching the Soroban BytesN<32>. */
  tradeId: string;
  /** The revealed preimage, 0x-prefixed hex, ready to pass to the EVM leg. */
  secret: string;
  /** Ledger the event was emitted in. */
  ledger: number;
}

type TopicEntry = xdr.ScVal | string;

/** Convert a topic/value entry (ScVal or base64 XDR string) to a native JS value. */
function toNative(entry: TopicEntry): unknown {
  const scv = typeof entry === 'string' ? xdr.ScVal.fromXDR(entry, 'base64') : entry;
  return scValToNative(scv);
}

function toHex(value: unknown): string | null {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Buffer.isBuffer(value)) return value.toString('hex');
  return null;
}

/**
 * Decode a raw Soroban event into a {@link ReleasedEvent}, or `null` if it is
 * not a well-formed `released` event from the atomic-swap contract.
 *
 * The contract emits: topics `[Symbol("released"), id: BytesN<32>]`, value
 * `secret: BytesN<32>`. This is a pure function so it can be unit-tested with
 * synthetic events and reused wherever events are read (poll or stream).
 */
export function decodeReleasedEvent(raw: {
  topic?: TopicEntry[];
  value?: TopicEntry;
  ledger?: number;
}): ReleasedEvent | null {
  const topics = raw.topic ?? [];
  if (topics.length < 2 || raw.value === undefined) return null;

  const kind = toNative(topics[0]);
  if (kind !== 'released') return null;

  const tradeId = toHex(toNative(topics[1]));
  const secretHex = toHex(toNative(raw.value));
  if (!tradeId || !secretHex) return null;

  return {
    tradeId,
    secret: `0x${secretHex}`,
    ledger: raw.ledger ?? 0,
  };
}

export interface WatcherOptions {
  contractId: string;
  startLedger?: number;
  pollIntervalMs?: number;
}

/**
 * Polls Soroban RPC `getEvents` for the atomic-swap contract's `released`
 * events. Polling (not streaming) is the native Soroban model: `getEvents` is
 * pull-based with a ledger cursor, which also gives free gap-recovery on
 * restart. See docs/cross-chain-relayer.md for the trade-off discussion.
 */
export class SorobanWatcher {
  private readonly server: Server;
  private readonly contractId: string;
  private readonly pollIntervalMs: number;
  private cursorLedger: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(server: Server, options: WatcherOptions) {
    this.server = server;
    this.contractId = options.contractId;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.cursorLedger = options.startLedger;
  }

  /** One poll cycle: fetch new events, decode the `released` ones, advance cursor. */
  async pollOnce(): Promise<ReleasedEvent[]> {
    const startLedger = this.cursorLedger ?? (await this.server.getLatestLedger()).sequence;

    const res = await this.server.getEvents({
      startLedger,
      filters: [{ type: 'contract', contractIds: [this.contractId] }],
    });

    const decoded: ReleasedEvent[] = [];
    for (const ev of res.events ?? []) {
      const parsed = decodeReleasedEvent(ev as never);
      if (parsed) decoded.push(parsed);
    }

    // Advance the cursor past the newest ledger we have seen so the next poll
    // does not re-deliver the same events.
    if (res.latestLedger) this.cursorLedger = res.latestLedger + 1;
    return decoded;
  }

  /** Start polling. Each decoded `released` event is passed to `onEvent`. */
  start(onEvent: (event: ReleasedEvent) => Promise<void> | void): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const events = await this.pollOnce();
        for (const ev of events) await onEvent(ev);
      } catch (err) {
        console.error('[relayer] poll error:', err);
      } finally {
        this.polling = false;
      }
    };
    this.timer = setInterval(tick, this.pollIntervalMs);
    void tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
