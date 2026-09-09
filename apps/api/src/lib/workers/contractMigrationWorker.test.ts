import { describe, it, expect, vi } from "vitest";
import { ContractMigrationWorker } from "./contractMigrationWorker.js";

describe("ContractMigrationWorker", () => {
  it("verifies storage migration when versions match", async () => {
    const worker = new ContractMigrationWorker({
      verifyStorageVersion: async () => 2,
    });

    const result = await worker.verifyContractStorage("CBJQHRGVAHLN5ZEIAIEBMR63Y2HVHUDZPRE6ZFULBS7LE756AT5ZIAGG", 2);
    expect(result.status).toBe("VERIFIED");
    expect(result.targetVersion).toBe(2);
    expect(result.migratedCount).toBe(1);
    expect(result.errorDetails).toBeUndefined();
  });

  it("reports failure when storage version does not match target", async () => {
    const worker = new ContractMigrationWorker({
      verifyStorageVersion: async () => 1,
    });

    const result = await worker.verifyContractStorage("CBJQHRGVAHLN5ZEIAIEBMR63Y2HVHUDZPRE6ZFULBS7LE756AT5ZIAGG", 2);
    expect(result.status).toBe("FAILED");
    expect(result.migratedCount).toBe(0);
    expect(result.errorDetails).toContain("Storage version mismatch");
  });

  it("handles verification errors gracefully", async () => {
    const worker = new ContractMigrationWorker({
      verifyStorageVersion: async () => {
        throw new Error("RPC timeout");
      },
    });

    const result = await worker.verifyContractStorage("CBJQHRGVAHLN5ZEIAIEBMR63Y2HVHUDZPRE6ZFULBS7LE756AT5ZIAGG", 2);
    expect(result.status).toBe("FAILED");
    expect(result.errorDetails).toBe("RPC timeout");
  });
});
