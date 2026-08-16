import { describe, expect, it } from "vitest";
import {
  evaluateReserveConservation,
  INVARIANT_RESERVE_CONSERVATION,
  type InvariantBalanceSnapshot,
} from "./invariant-checker.js";

function snapshot(overrides: Partial<InvariantBalanceSnapshot> = {}): InvariantBalanceSnapshot {
  return {
    totalLockedStroops: 1_000_000n,
    totalAllocatedStroops: 0n,
    feeAccumulatorStroops: 0n,
    actualContractBalanceStroops: 1_000_000n,
    ledger: 49281901,
    ...overrides,
  };
}

describe("evaluateReserveConservation (INV-07)", () => {
  it("reports HEALTHY when expected total matches the contract balance", () => {
    const result = evaluateReserveConservation(snapshot());
    expect(result.status).toBe("HEALTHY");
    expect(result.action).toBe("NO_ACTION");
    expect(result.driftStroops).toBe(0n);
    expect(result.violatedInvariant).toBeUndefined();
  });

  it("counts allocated tranches and fee accumulator toward the expected total", () => {
    const result = evaluateReserveConservation(
      snapshot({
        totalLockedStroops: 500n,
        totalAllocatedStroops: 300n,
        feeAccumulatorStroops: 200n,
        actualContractBalanceStroops: 1_000n,
      }),
    );
    expect(result.status).toBe("HEALTHY");
    expect(result.expectedTotalStroops).toBe(1_000n);
    expect(result.evidence["fee_accumulator"]).toBe("200");
  });

  it("flags VIOLATED and recommends a pause when drift exceeds tolerance", () => {
    const result = evaluateReserveConservation(
      snapshot({ actualContractBalanceStroops: 999_000n }),
    );
    expect(result.status).toBe("VIOLATED");
    expect(result.action).toBe("PAUSE_SINGLE_ESCROW");
    expect(result.violatedInvariant).toBe(INVARIANT_RESERVE_CONSERVATION);
    expect(result.driftStroops).toBe(1_000n);
    expect(result.evidence["drift"]).toBe("1000");
  });

  it("flags VIOLATED when the contract holds more than expected", () => {
    const result = evaluateReserveConservation(
      snapshot({ actualContractBalanceStroops: 1_001_000n }),
    );
    expect(result.status).toBe("VIOLATED");
    expect(result.driftStroops).toBe(1_000n);
  });

  it("allows sub-tolerance drift when a tolerance is configured", () => {
    const result = evaluateReserveConservation(snapshot({ actualContractBalanceStroops: 1_000_001n }), {
      toleranceStroops: 10n,
      warningThresholdStroops: 10n,
    });
    expect(result.status).toBe("HEALTHY");
  });

  it("reports WARNING for drift above warning threshold but within tolerance", () => {
    const result = evaluateReserveConservation(
      snapshot({ actualContractBalanceStroops: 1_000_005n }),
      { toleranceStroops: 10n, warningThresholdStroops: 2n },
    );
    expect(result.status).toBe("WARNING");
    expect(result.action).toBe("NO_ACTION");
    expect(result.violatedInvariant).toBeUndefined();
  });

  it("carries evidence with ledger and balance breakdown", () => {
    const result = evaluateReserveConservation(snapshot({ ledger: 123 }));
    expect(result.evidence.ledger).toBe(123);
    expect(result.evidence["total_locked"]).toBe("1000000");
  });
});
