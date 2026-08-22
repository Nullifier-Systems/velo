import { describe, expect, it } from "vitest";
import { RelayerCoordinator, integerSqrt } from "./coordinator.js";
import type { EvmHtlcClient } from "./evm-htlc.js";
import type { ReleasedEvent } from "./soroban-watcher.js";

class MockEvmHtlcForCoordinator {
  readonly id: string;
  stake: bigint = 0n;
  attestedSecrets: string[] = [];

  constructor(id: string) {
    this.id = id;
  }

  createClient(sharedState: {
    totalWeight: bigint;
    attestedWeight: bigint;
    withdrawn: boolean;
  }): EvmHtlcClient {
    return {
      withdraw: async (secretHex: string) => {
        this.attestedSecrets.push(secretHex);
        const weight = integerSqrt(this.stake);
        sharedState.attestedWeight += weight;
        const threshold = (sharedState.totalWeight * 67n + 99n) / 100n;
        if (sharedState.attestedWeight >= threshold) {
          sharedState.withdrawn = true;
        }
        return `0xtx_withdraw_${this.id}`;
      },
      submitAttestation: async (secretHex: string) => {
        this.attestedSecrets.push(secretHex);
        const weight = integerSqrt(this.stake);
        sharedState.attestedWeight += weight;
        const threshold = (sharedState.totalWeight * 67n + 99n) / 100n;
        if (sharedState.attestedWeight >= threshold) {
          sharedState.withdrawn = true;
        }
        return `0xtx_attest_${this.id}`;
      },
      joinRelayer: async (stake?: bigint) => {
        this.stake = stake ?? 1000n;
        return `0xtx_join_${this.id}`;
      },
    };
  }
}

describe("Relayer Coordinator", () => {
  it("computes quadratic integer square root correctly", () => {
    expect(integerSqrt(0n)).toBe(0n);
    expect(integerSqrt(1n)).toBe(1n);
    expect(integerSqrt(4n)).toBe(2n);
    expect(integerSqrt(9n)).toBe(3n);
    expect(integerSqrt(100n)).toBe(10n);
    expect(integerSqrt(10000n)).toBe(100n);
  });

  it("successfully coordinates 3 test relayers to withdraw a testnet HTLC", async () => {
    const coordinator = new RelayerCoordinator({
      thresholdPct: 67,
      minStake: 1000n,
    });

    const sharedState = {
      totalWeight: 0n,
      attestedWeight: 0n,
      withdrawn: false,
    };

    const node1 = new MockEvmHtlcForCoordinator("relayer-1");
    const node2 = new MockEvmHtlcForCoordinator("relayer-2");
    const node3 = new MockEvmHtlcForCoordinator("relayer-3");

    // Stake 3 relayers:
    // node-1: 10,000 stake -> weight 100
    // node-2: 10,000 stake -> weight 100
    // node-3: 10,000 stake -> weight 100
    // Total weight = 300. Threshold = (300 * 67 + 99) / 100 = 202
    await coordinator.registerRelayer("relayer-1", node1.createClient(sharedState), 10000n);
    await coordinator.registerRelayer("relayer-2", node2.createClient(sharedState), 10000n);
    await coordinator.registerRelayer("relayer-3", node3.createClient(sharedState), 10000n);

    sharedState.totalWeight = coordinator.getTotalActiveWeight();
    expect(coordinator.getTotalActiveWeight()).toBe(300n);
    expect(coordinator.getThresholdWeight()).toBe(201n);

    const event: ReleasedEvent = {
      tradeId: "test-trade-12345",
      secret: `0x${"ab".repeat(32)}`,
      ledger: 1500,
    };

    const result = await coordinator.coordinateClaim(event);

    expect(result.withdrawn).toBe(true);
    expect(result.txHashes).toHaveLength(3); // All 3 nodes attested to reach 300 >= 202
    expect(result.accumulatedWeight).toBe(300n);
    expect(result.thresholdWeight).toBe(201n);
    expect(sharedState.withdrawn).toBe(true);
  });
});
