import { describe, expect, it } from "vitest";
import { Relayer, RelayerNetwork, type RelayerLogger } from "./relayer.js";
import type { EvmHtlcClient, RelayerInfo } from "./evm-htlc.js";
import type { ReleasedEvent, SorobanWatcher } from "./soroban-watcher.js";

const silentLogger: RelayerLogger = { info: () => {}, error: () => {} };
const noopWatcher = {} as unknown as SorobanWatcher;

function makeEvent(overrides: Partial<ReleasedEvent> = {}): ReleasedEvent {
  return {
    tradeId: "aa".repeat(32),
    secret: `0x${"bb".repeat(32)}`,
    ledger: 100,
    ...overrides,
  };
}

function integerSqrt(y: bigint): bigint {
  if (y === 0n) return 0n;
  let z = y;
  let x = y / 2n + 1n;
  while (x < z) {
    z = x;
    x = (y / x + x) / 2n;
  }
  return z;
}

/**
 * In-memory state machine matching `contracts-evm/HTLC.sol` with stake-bonded registry.
 */
class MockStakeBondedHtlcContract {
  readonly minStake: bigint;
  readonly unstakeDelayBlocks: bigint;
  readonly thresholdPct: number;

  relayers = new Map<string, RelayerInfo>();
  stakeUnlock = new Map<string, bigint>();
  pendingUnstake = new Map<string, bigint>();
  totalActiveStake = 0n;
  totalActiveWeight = 0n;
  currentBlock = 100n;

  private readonly attestations = new Map<string, Map<string, bigint>>(); // secret -> (relayerId -> weight)
  private readonly secretsAttestedByRelayer = new Map<string, Set<string>>(); // relayerId -> Set(secret)
  private readonly withdrawnSecrets = new Set<string>();

  constructor(options: { minStake?: bigint; unstakeDelayBlocks?: bigint; thresholdPct?: number } = {}) {
    this.minStake = options.minStake ?? 100n;
    this.unstakeDelayBlocks = options.unstakeDelayBlocks ?? 1000n;
    this.thresholdPct = options.thresholdPct ?? 67;
  }

  joinRelayer(relayerId: string, stake: bigint): void {
    if (stake < this.minStake) {
      throw new Error("stake below minRelayerStake");
    }
    const existing = this.relayers.get(relayerId);
    const oldWeight = existing?.active ? integerSqrt(existing.stake) : 0n;

    const newStake = (existing?.stake ?? 0n) + stake;
    const newWeight = integerSqrt(newStake);

    this.relayers.set(relayerId, {
      addr: relayerId,
      stake: newStake,
      joinedBlock: this.currentBlock,
      lastAttestation: 0n,
      active: true,
    });

    this.totalActiveStake += stake;
    this.totalActiveWeight = this.totalActiveWeight - oldWeight + newWeight;
  }

  leaveRelayer(relayerId: string): void {
    const r = this.relayers.get(relayerId);
    if (!r || !r.active) {
      throw new Error("caller is not an active relayer");
    }
    const weight = integerSqrt(r.stake);
    const stake = r.stake;

    r.active = false;
    r.stake = 0n;
    this.totalActiveStake -= stake;
    this.totalActiveWeight -= weight;

    this.stakeUnlock.set(relayerId, this.currentBlock + this.unstakeDelayBlocks);
    this.pendingUnstake.set(relayerId, stake);
  }

  withdrawStake(relayerId: string): bigint {
    const unlock = this.stakeUnlock.get(relayerId) ?? 0n;
    if (unlock === 0n) throw new Error("no unstake in progress");
    if (this.currentBlock < unlock) throw new Error("unstake delay not elapsed");

    const amount = this.pendingUnstake.get(relayerId) ?? 0n;
    if (amount === 0n) throw new Error("no pending stake");

    this.stakeUnlock.delete(relayerId);
    this.pendingUnstake.delete(relayerId);
    return amount;
  }

  slashDoubleAttest(relayerId: string, secret1: string, secret2: string): bigint {
    if (secret1 === secret2) throw new Error("identical secrets");
    const attested = this.secretsAttestedByRelayer.get(relayerId);
    if (!attested || !attested.has(secret1) || !attested.has(secret2)) {
      throw new Error("contradictory attestation not proven");
    }

    const r = this.relayers.get(relayerId);
    const totalStake = (r?.stake ?? 0n) + (this.pendingUnstake.get(relayerId) ?? 0n);
    if (r) {
      if (r.active) {
        this.totalActiveWeight -= integerSqrt(r.stake);
        this.totalActiveStake -= r.stake;
      }
      r.active = false;
      r.stake = 0n;
    }
    this.pendingUnstake.delete(relayerId);
    return totalStake;
  }

  threshold(): bigint {
    if (this.totalActiveWeight === 0n) return 0n;
    return (this.totalActiveWeight * BigInt(this.thresholdPct) + 99n) / 100n;
  }

  submitAttestation(relayerId: string, secretHex: string): { success: boolean; withdrawn: boolean; error?: string; txHash?: string } {
    const r = this.relayers.get(relayerId);
    if (!r || !r.active) {
      return { success: false, withdrawn: false, error: "caller is not an authorized relayer" };
    }
    if (this.withdrawnSecrets.has(secretHex)) {
      return { success: true, withdrawn: true, txHash: "0xalready_withdrawn" };
    }

    if (!this.attestations.has(secretHex)) {
      this.attestations.set(secretHex, new Map());
    }
    const map = this.attestations.get(secretHex)!;
    if (map.has(relayerId)) {
      return { success: false, withdrawn: this.isWithdrawn(secretHex), error: "relayer already attested" };
    }

    const weight = integerSqrt(r.stake);
    map.set(relayerId, weight);

    if (!this.secretsAttestedByRelayer.has(relayerId)) {
      this.secretsAttestedByRelayer.set(relayerId, new Set());
    }
    this.secretsAttestedByRelayer.get(relayerId)!.add(secretHex);

    let currentWeight = 0n;
    for (const w of map.values()) {
      currentWeight += w;
    }

    const reqThreshold = this.threshold();
    if (currentWeight >= reqThreshold) {
      this.withdrawnSecrets.add(secretHex);
      return { success: true, withdrawn: true, txHash: `0xtx_claimed_${secretHex.slice(0, 10)}` };
    }

    return { success: true, withdrawn: false, txHash: `0xattested_${currentWeight}_of_${reqThreshold}` };
  }

  isWithdrawn(secretHex: string): boolean {
    return this.withdrawnSecrets.has(secretHex);
  }

  getAttestedWeight(secretHex: string): bigint {
    const map = this.attestations.get(secretHex);
    if (!map) return 0n;
    let sum = 0n;
    for (const w of map.values()) sum += w;
    return sum;
  }
}

function createMockEvmClient(contract: MockStakeBondedHtlcContract, relayerId: string): EvmHtlcClient {
  return {
    async submitAttestation(secretHex: string): Promise<string> {
      const res = contract.submitAttestation(relayerId, secretHex);
      if (!res.success) throw new Error(res.error);
      return res.txHash ?? "0xtxhash";
    },
    async withdraw(secretHex: string): Promise<string> {
      const res = contract.submitAttestation(relayerId, secretHex);
      if (!res.success) throw new Error(res.error);
      return res.txHash ?? "0xtxhash";
    },
    async joinRelayer(stake?: bigint): Promise<string> {
      contract.joinRelayer(relayerId, stake ?? 100n);
      return "0xjoin_tx";
    },
    async leaveRelayer(): Promise<string> {
      contract.leaveRelayer(relayerId);
      return "0xleave_tx";
    },
    async withdrawStake(): Promise<string> {
      contract.withdrawStake(relayerId);
      return "0xwithdraw_stake_tx";
    },
    async slashDoubleAttest(addr: string, s1: string, s2: string): Promise<string> {
      contract.slashDoubleAttest(addr, s1, s2);
      return "0xslash_tx";
    },
    async getRelayerInfo(addr: string) {
      const r = contract.relayers.get(addr);
      return {
        addr,
        stake: r?.stake ?? 0n,
        joinedBlock: r?.joinedBlock ?? 0n,
        lastAttestation: r?.lastAttestation ?? 0n,
        active: r?.active ?? false,
      };
    },
    async getThreshold() {
      return contract.threshold();
    },
    async getTotalActiveWeight() {
      return contract.totalActiveWeight;
    },
    async getAttestedWeight(secret: string) {
      return contract.getAttestedWeight(secret);
    },
  };
}

describe("Stake-Bonded Relayer Consensus & Network Integration", () => {
  it("Requirement: Single relayer with stake below 67% threshold cannot withdraw alone", async () => {
    const mockContract = new MockStakeBondedHtlcContract({ minStake: 100n, thresholdPct: 67 });
    mockContract.joinRelayer("node-1", 100n); // weight = 10
    mockContract.joinRelayer("node-2", 100n); // weight = 10
    mockContract.joinRelayer("node-3", 100n); // weight = 10
    // Total weight = 30 -> 67% threshold = (30*67+99)/100 = 22

    const network = new RelayerNetwork({ threshold: 22, total: 30 });
    const relayer1 = new Relayer(noopWatcher, createMockEvmClient(mockContract, "node-1"), silentLogger, "node-1");
    network.addRelayer("node-1", relayer1);

    const event = makeEvent();
    const results = await network.broadcastReleased(event);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("claimed"); // relayer submitted attestation
    expect(mockContract.getAttestedWeight(event.secret)).toBe(10n); // weight 10 < 22
    expect(mockContract.isWithdrawn(event.secret)).toBe(false); // not withdrawn
  });

  it("Requirement: Multi-relayer weighted aggregation reaching 67% threshold executes claim", async () => {
    const mockContract = new MockStakeBondedHtlcContract({ minStake: 100n, thresholdPct: 67 });
    mockContract.joinRelayer("node-1", 100n); // weight = 10
    mockContract.joinRelayer("node-2", 400n); // weight = 20
    mockContract.joinRelayer("node-3", 100n); // weight = 10
    // Total weight = 40. Threshold = (40*67+99)/100 = 27

    const network = new RelayerNetwork({ threshold: 27, total: 40 });
    const relayer1 = new Relayer(noopWatcher, createMockEvmClient(mockContract, "node-1"), silentLogger, "node-1");
    const relayer2 = new Relayer(noopWatcher, createMockEvmClient(mockContract, "node-2"), silentLogger, "node-2");

    network.addRelayer("node-1", relayer1);
    network.addRelayer("node-2", relayer2);

    const event = makeEvent();
    const results = await network.broadcastReleased(event);

    expect(results).toHaveLength(2);
    expect(mockContract.getAttestedWeight(event.secret)).toBe(30n); // 10 + 20 = 30 >= 27
    expect(mockContract.isWithdrawn(event.secret)).toBe(true);
  });

  it("Requirement: Slashing double-attestation penalizes rogue relayer", async () => {
    const mockContract = new MockStakeBondedHtlcContract({ minStake: 100n });
    mockContract.joinRelayer("rogue", 100n);

    const client = createMockEvmClient(mockContract, "rogue");
    const secret1 = `0x${"11".repeat(32)}`;
    const secret2 = `0x${"22".repeat(32)}`;

    await client.submitAttestation!(secret1);
    await client.submitAttestation!(secret2);

    const slashed = mockContract.slashDoubleAttest("rogue", secret1, secret2);
    expect(slashed).toBe(100n);
    expect(mockContract.relayers.get("rogue")?.active).toBe(false);
    expect(mockContract.relayers.get("rogue")?.stake).toBe(0n);
  });

  it("Requirement: Unstake delay enforces timelock", async () => {
    const mockContract = new MockStakeBondedHtlcContract({ minStake: 100n, unstakeDelayBlocks: 1000n });
    mockContract.joinRelayer("staker", 100n);

    mockContract.leaveRelayer("staker");
    expect(mockContract.stakeUnlock.get("staker")).toBe(1100n);

    // Immediate withdraw fails
    expect(() => mockContract.withdrawStake("staker")).toThrow("unstake delay not elapsed");

    // Advance block
    mockContract.currentBlock = 1100n;
    const returned = mockContract.withdrawStake("staker");
    expect(returned).toBe(100n);
  });
});
