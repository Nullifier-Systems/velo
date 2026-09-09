import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contractGovernanceRoutes } from "./contract-governance.js";

const VALID_CONTRACT = "C" + "A".repeat(55);
const VALID_HASH = "a".repeat(64);
const SIGNER_1 = "G" + "A".repeat(55);
const SIGNER_2 = "G" + "B".repeat(55);
const SIG_1 = "11".repeat(32);
const SIG_2 = "22".repeat(32);

describe("contract-governance admin endpoints (#464)", () => {
  const adminKey = "test-governance-admin-key";

  beforeEach(() => {
    process.env.ADMIN_API_KEY = adminKey;
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    vi.restoreAllMocks();
  });

  async function buildApp(opts: any = {}) {
    const app = Fastify();
    await app.register(contractGovernanceRoutes, {
      prefix: "/api/v1",
      ...opts,
    });
    await app.ready();
    return app;
  }

  it("rejects unauthorized calls with 401", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/contracts/upgrade",
      payload: {
        contractId: VALID_CONTRACT,
        newWasmHash: VALID_HASH,
        storageVersion: 2,
        signatures: [
          { signerAddress: SIGNER_1, signature: SIG_1 },
          { signerAddress: SIGNER_2, signature: SIG_2 },
        ],
      },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects upgrades with insufficient signatures (< 2) with 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/contracts/upgrade",
      headers: {
        "x-admin-api-key": adminKey,
      },
      payload: {
        contractId: VALID_CONTRACT,
        newWasmHash: VALID_HASH,
        storageVersion: 2,
        signatures: [
          { signerAddress: SIGNER_1, signature: SIG_1 },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects duplicate signers with 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/contracts/upgrade",
      headers: {
        "x-admin-api-key": adminKey,
      },
      payload: {
        contractId: VALID_CONTRACT,
        newWasmHash: VALID_HASH,
        storageVersion: 2,
        signatures: [
          { signerAddress: SIGNER_1, signature: SIG_1 },
          { signerAddress: SIGNER_1, signature: SIG_1 },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("DUPLICATE_SIGNER");
    await app.close();
  });

  it("successfully upgrades contract with 2-of-3 signatures", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({ txHash: "tx_mock_hash_123" });
    const app = await buildApp({ invokeUpgradeAndMigrate: mockInvoke });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/contracts/upgrade",
      headers: {
        "x-admin-api-key": adminKey,
      },
      payload: {
        contractId: VALID_CONTRACT,
        newWasmHash: VALID_HASH,
        storageVersion: 2,
        signatures: [
          { signerAddress: SIGNER_1, signature: SIG_1 },
          { signerAddress: SIGNER_2, signature: SIG_2 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.txHash).toBe("tx_mock_hash_123");
    expect(body.storageVersion).toBe(2);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
