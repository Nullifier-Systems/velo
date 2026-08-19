import { ethers } from "ethers";
import type { EvmHtlcClient, RelayerInfo } from "./evm-htlc.js";
import { Relayer, type RelayerLogger } from "./relayer.js";
import type { ReleasedEvent, SorobanWatcher } from "./soroban-watcher.js";

export interface CoordinatorConfig {
  thresholdPct: number;
  minStake: bigint;
  logger?: RelayerLogger;
}

export interface CoordinatorRelayerEntry {
  id: string;
  client: EvmHtlcClient;
  relayer: Relayer;
  stake: bigint;
  weight: bigint;
}

export interface CoordinationResult {
  hashlock: string;
  secret: string;
  totalWeight: bigint;
  accumulatedWeight: bigint;
  thresholdWeight: bigint;
  attestationsCount: number;
  withdrawn: boolean;
  txHashes: string[];
}

const defaultLogger: RelayerLogger = {
  info: (msg, ...args) => console.log(`[coordinator] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[coordinator] ${msg}`, ...args),
};

/** Integer square root for quadratic stake weighting. */
export function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("square root of negative number");
  if (value === 0n) return 0n;
  let z = value;
  let x = value / 2n + 1n;
  while (x < z) {
    z = x;
    x = (value / x + x) / 2n;
  }
  return z;
}

/**
 * Coordinates a network of stake-bonded relayers to achieve consensus
 * and execute cross-chain claims on EVM HTLC contracts.
 */
export class RelayerCoordinator {
  private readonly relayers: Map<string, CoordinatorRelayerEntry> = new Map();
  private readonly thresholdPct: number;
  private readonly minStake: bigint;
  private readonly logger: RelayerLogger;

  constructor(config: Partial<CoordinatorConfig> = {}) {
    this.thresholdPct = config.thresholdPct ?? 67;
    this.minStake = config.minStake ?? 1000n;
    this.logger = config.logger ?? defaultLogger;
  }

  /** Register an active relayer node into the coordinator pool. */
  async registerRelayer(
    id: string,
    client: EvmHtlcClient,
    stake: bigint,
    watcher?: SorobanWatcher
  ): Promise<CoordinatorRelayerEntry> {
    if (stake < this.minStake) {
      throw new Error(`Stake ${stake} is below minimum requirement ${this.minStake}`);
    }

    const weight = integerSqrt(stake);
    const mockWatcher = watcher ?? ({} as SorobanWatcher);
    const relayer = new Relayer(mockWatcher, client, this.logger, id);

    // Call joinRelayer on contract if supported
    if (client.joinRelayer) {
      try {
        await client.joinRelayer(stake);
      } catch (err) {
        this.logger.info(`[${id}] joinRelayer notice: ${(err as Error).message}`);
      }
    }

    const entry: CoordinatorRelayerEntry = {
      id,
      client,
      relayer,
      stake,
      weight,
    };

    this.relayers.set(id, entry);
    this.logger.info(`Registered relayer ${id} with stake ${stake} (weight ${weight})`);
    return entry;
  }

  /** Calculate current total active weight across all bonded relayers. */
  getTotalActiveWeight(): bigint {
    let total = 0n;
    for (const entry of this.relayers.values()) {
      total += entry.weight;
    }
    return total;
  }

  /** Calculate current threshold weight needed to achieve consensus (e.g. 67% ceiling). */
  getThresholdWeight(): bigint {
    const total = this.getTotalActiveWeight();
    if (total === 0n) return 0n;
    return (total * BigInt(this.thresholdPct) + 99n) / 100n;
  }

  /** Get registered relayer entry. */
  getRelayer(id: string): CoordinatorRelayerEntry | undefined {
    return this.relayers.get(id);
  }

  /** Get all registered relayers. */
  getAllRelayers(): CoordinatorRelayerEntry[] {
    return Array.from(this.relayers.values());
  }

  /**
   * Coordinates the submission of attestations across registered relayers until
   * the required threshold is met and the HTLC is settled.
   */
  async coordinateClaim(event: ReleasedEvent): Promise<CoordinationResult> {
    const secretBytes = ethers.getBytes(event.secret);
    const hashlock = ethers.sha256(secretBytes);
    const totalWeight = this.getTotalActiveWeight();
    const thresholdWeight = this.getThresholdWeight();

    this.logger.info(
      `Coordinating claim for trade ${event.tradeId} (hashlock ${hashlock}): totalWeight=${totalWeight}, threshold=${thresholdWeight}`
    );

    let accumulatedWeight = 0n;
    let attestationsCount = 0;
    let withdrawn = false;
    const txHashes: string[] = [];

    for (const entry of this.relayers.values()) {
      try {
        const txHash = entry.client.submitAttestation
          ? await entry.client.submitAttestation(event.secret)
          : await entry.client.withdraw(event.secret);

        txHashes.push(txHash);
        accumulatedWeight += entry.weight;
        attestationsCount++;

        this.logger.info(
          `Relayer ${entry.id} attested: accumulatedWeight=${accumulatedWeight}/${thresholdWeight}`
        );

        if (accumulatedWeight >= thresholdWeight) {
          withdrawn = true;
          this.logger.info(
            `Quorum reached (${accumulatedWeight} >= ${thresholdWeight}) for secret ${event.secret}`
          );
          break;
        }
      } catch (err) {
        this.logger.error(`Relayer ${entry.id} failed to attest: ${(err as Error).message}`);
      }
    }

    return {
      hashlock,
      secret: event.secret,
      totalWeight,
      accumulatedWeight,
      thresholdWeight,
      attestationsCount,
      withdrawn,
      txHashes,
    };
  }
}
