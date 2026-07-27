import { describe, expect, it } from "vitest";
import { Relayer, RelayerNetwork, type RelayerLogger } from "./relayer.js";
import type { EvmHtlcClient } from "./evm-htlc.js";
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

/**
 * In-memory state machine matching `contracts-evm/HTLC.sol` threshold-attestation consensus.
 */
class MockThresholdHtlcContract {
  readonly threshold: number;
  readonly authorizedRelayers: Set<string>;

  private readonly attestations = new Map<string, Set<string>>(); // secret -> Set(relayerId)
  private readonly withdrawnSecrets = new Set<string>();

  constructor(threshold: number, authorizedRelayers: string[]) {
    this.threshold = threshold;
    this.authorizedRelayers = new Set(authorizedRelayers);
  }

  submitAttestation(relayerId: string, secretHex: string): { success: boolean; withdrawn: boolean; error?: string; txHash?: string } {
    if (!this.authorizedRelayers.has(relayerId)) {
      return { success: false, withdrawn: false, error: "caller is not an authorized relayer" };
    }
    if (this.withdrawnSecrets.has(secretHex)) {
      return { success: true, withdrawn: true, txHash: "0xalready_withdrawn" };
    }

    if (!this.attestations.has(secretHex)) {
      this.attestations.set(secretHex, new Set());
    }
    const relayerSet = this.attestations.get(secretHex)!;

    if (relayerSet.has(relayerId)) {
      return { success: false, withdrawn: this.isWithdrawn(secretHex), error: "relayer already attested" };
    }

    relayerSet.add(relayerId);
    const count = relayerSet.size;

    if (count >= this.threshold) {
      this.withdrawnSecrets.add(secretHex);
      return { success: true, withdrawn: true, txHash: `0xtx_claimed_${secretHex.slice(0, 10)}` };
    }

    return { success: true, withdrawn: false, txHash: `0xattested_${count}_of_${this.threshold}` };
  }

  isWithdrawn(secretHex: string): boolean {
    return this.withdrawnSecrets.has(secretHex);
  }

  getAttestationCount(secretHex: string): number {
    return this.attestations.get(secretHex)?.size ?? 0;
  }
}

function createMockEvmClient(contract: MockThresholdHtlcContract, relayerId: string): EvmHtlcClient {
  return {
    async submitAttestation(secretHex: string): Promise<string> {
      const res = contract.submitAttestation(relayerId, secretHex);
      if (!res.success) {
        throw new Error(res.error);
      }
      return res.txHash ?? "0xtxhash";
    },
    async withdraw(secretHex: string): Promise<string> {
      const res = contract.submitAttestation(relayerId, secretHex);
      if (!res.success) {
        throw new Error(res.error);
      }
      return res.txHash ?? "0xtxhash";
    },
  };
}

describe("Byzantine-Fault-Tolerant Relayer Network Integration", () => {
  it("Requirement 8: Claim succeeds with 1 relayer offline (N=3, M=2, f=1)", async () => {
    const threshold = 2;
    const total = 3;
    const authorized = ["node-1", "node-2", "node-3"];

    const mockContract = new MockThresholdHtlcContract(threshold, authorized);
    const network = new RelayerNetwork({ threshold, total });

    // Node 1 and Node 2 are online; Node 3 is offline (not added to network)
    const relayer1 = new Relayer(noopWatcher, createMockEvmClient(mockContract, "node-1"), silentLogger, "node-1");
    const relayer2 = new Relayer(noopWatcher, createMockEvmClient(mockContract, "node-2"), silentLogger, "node-2");

    network.addRelayer("node-1", relayer1);
    network.addRelayer("node-2", relayer2);

    const event = makeEvent();

    // Verify initial state: not withdrawn, 0 attestations
    expect(mockContract.isWithdrawn(event.secret)).toBe(false);
    expect(mockContract.getAttestationCount(event.secret)).toBe(0);

    // Both online relayers process the event
    const results = await network.broadcastReleased(event);

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("claimed");
    expect(results[1].status).toBe("claimed");

    // Contract threshold of 2 attestations was met, claim succeeds!
    expect(mockContract.getAttestationCount(event.secret)).toBe(2);
    expect(mockContract.isWithdrawn(event.secret)).toBe(true);
  });

  it("Requirement 9: Claim succeeds with 1 relayer acting maliciously (N=3, M=2, f=1)", async () => {
    const threshold = 2;
    const total = 3;
    const authorized = ["honest-1", "rogue-2", "honest-3"];

    const mockContract = new MockThresholdHtlcContract(threshold, authorized);
    const network = new RelayerNetwork({ threshold, total });

    // Honest Relayer 1
    const relayer1 = new Relayer(noopWatcher, createMockEvmClient(mockContract, "honest-1"), silentLogger, "honest-1");

    // Rogue Relayer 2 refuses to sign / submits corrupt secret attestation
    const rogueEvmClient: EvmHtlcClient = {
      async submitAttestation(_secretHex: string): Promise<string> {
        // Malicious behavior: attempts to attest to a fake secret or throws
        throw new Error("Malicious relayer refused to sign valid attestation");
      },
      async withdraw(secretHex: string): Promise<string> {
        return this.submitAttestation!(secretHex);
      },
    };
    const relayer2 = new Relayer(noopWatcher, rogueEvmClient, silentLogger, "rogue-2");

    // Honest Relayer 3
    const relayer3 = new Relayer(noopWatcher, createMockEvmClient(mockContract, "honest-3"), silentLogger, "honest-3");

    network.addRelayer("honest-1", relayer1);
    network.addRelayer("rogue-2", relayer2);
    network.addRelayer("honest-3", relayer3);

    const event = makeEvent();

    const results = await network.broadcastReleased(event);

    expect(results[0].status).toBe("claimed");
    expect(results[1].status).toBe("failed"); // Rogue node failed
    expect(results[2].status).toBe("claimed");

    // Despite 1 malicious relayer, 2 valid attestations reached contract threshold -> claim succeeds!
    expect(mockContract.getAttestationCount(event.secret)).toBe(2);
    expect(mockContract.isWithdrawn(event.secret)).toBe(true);
  });

  it("Requirement 10: Below-threshold agreement does NOT result in claim acceptance", async () => {
    const threshold = 2;
    const total = 3;
    const authorized = ["single-node", "node-2", "node-3"];

    const mockContract = new MockThresholdHtlcContract(threshold, authorized);
    const network = new RelayerNetwork({ threshold, total });

    // Only 1 relayer is active (below threshold M=2)
    const relayer1 = new Relayer(noopWatcher, createMockEvmClient(mockContract, "single-node"), silentLogger, "single-node");
    network.addRelayer("single-node", relayer1);

    const event = makeEvent();

    const results = await network.broadcastReleased(event);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("claimed"); // Relayer successfully submitted its attestation

    // BUT contract has only 1 attestation (< threshold 2) -> swap is NOT withdrawn!
    expect(mockContract.getAttestationCount(event.secret)).toBe(1);
    expect(mockContract.isWithdrawn(event.secret)).toBe(false);
  });
});
