import type { EvmHtlcClient } from './evm-htlc.js';
import type { ReleasedEvent, SorobanWatcher } from './soroban-watcher.js';

export interface RelayerLogger {
  info: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

const defaultLogger: RelayerLogger = {
  info: (msg, ...args) => console.log(`[relayer] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[relayer] ${msg}`, ...args),
};

export interface ClaimResult {
  tradeId: string;
  status: 'claimed' | 'skipped' | 'failed';
  txHash?: string;
  error?: string;
}

/**
 * Orchestrates the cross-chain claim: on each Soroban `released` event it takes
 * the revealed secret and submits `withdraw(secret)` on the EVM HTLC, which
 * pays the counterpart recipient. The EVM contract locates the swap by
 * `sha256(secret)`, so the secret is the only payload the relayer needs.
 *
 * Claims are idempotent per secret: a re-delivered event (Soroban `getEvents`
 * can overlap on the ledger cursor) will not submit a second withdraw.
 */
export class Relayer {
  private readonly watcher: SorobanWatcher;
  private readonly evm: EvmHtlcClient;
  private readonly logger: RelayerLogger;
  private readonly processed = new Set<string>();

  constructor(watcher: SorobanWatcher, evm: EvmHtlcClient, logger: RelayerLogger = defaultLogger) {
    this.watcher = watcher;
    this.evm = evm;
    this.logger = logger;
  }

  /** Handle a single decoded `released` event. Safe to call more than once. */
  async handleReleased(event: ReleasedEvent): Promise<ClaimResult> {
    if (this.processed.has(event.secret)) {
      this.logger.info(`skip already-claimed trade ${event.tradeId}`);
      return { tradeId: event.tradeId, status: 'skipped' };
    }
    // Mark before awaiting so overlapping deliveries can't double-submit.
    this.processed.add(event.secret);

    try {
      this.logger.info(`claiming EVM leg for trade ${event.tradeId} (ledger ${event.ledger})`);
      const txHash = await this.evm.withdraw(event.secret);
      this.logger.info(`claimed trade ${event.tradeId} -> EVM tx ${txHash}`);
      return { tradeId: event.tradeId, status: 'claimed', txHash };
    } catch (err) {
      // Allow a retry on a later delivery if the claim genuinely failed.
      this.processed.delete(event.secret);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`claim failed for trade ${event.tradeId}: ${message}`);
      return { tradeId: event.tradeId, status: 'failed', error: message };
    }
  }

  /** Start watching Soroban and claiming matching EVM HTLCs. Runs until stopped. */
  run(): void {
    this.logger.info('started; watching Soroban released events');
    this.watcher.start(async (event) => {
      await this.handleReleased(event);
    });
  }

  stop(): void {
    this.watcher.stop();
  }
}
