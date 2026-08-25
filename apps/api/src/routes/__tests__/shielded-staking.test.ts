import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  shieldedStakingRoutes,
  shieldedCommitmentStore,
  shieldedNullifierStore,
  resetMerkleState,
  getMerkleRoot,
} from "../shielded-staking.js";

describe("Shielded Staking Routes (Issue #427)", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    shieldedCommitmentStore.clear();
    shieldedNullifierStore.clear();
    resetMerkleState();
    app = Fastify();
    await app.register(shieldedStakingRoutes, { prefix: "/api/v1" });
    await app.ready();
  });

  it("accepts a valid shielded stake deposit", async () => {
    const commitmentHash = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake",
      payload: {
        commitmentHash,
        stakedAmountStroops: "500000000",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.commitmentHash).toBe(commitmentHash);
    expect(body.merkleRoot).toBeDefined();
    expect(body.merkleLeafIndex).toBe(0);
  });

  it("returns 409 for duplicate commitment", async () => {
    const commitmentHash = "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1";

    await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake",
      payload: { commitmentHash, stakedAmountStroops: "200000000" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake",
      payload: { commitmentHash, stakedAmountStroops: "200000000" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("COMMITMENT_EXISTS");
  });

  it("returns 400 for insufficient stake", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake",
      payload: {
        commitmentHash: "c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2",
        stakedAmountStroops: "10000000", // 1 USDC — below minimum
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INSUFFICIENT_STAKE");
  });

  it("verifies ZK proof and records nullifier", async () => {
    const commitmentHash = "d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3";
    const nullifierHash = "e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";

    // First deposit
    await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake",
      payload: { commitmentHash, stakedAmountStroops: "500000000" },
    });

    const merkleRoot = getMerkleRoot();

    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake/verify",
      payload: {
        proof: "valid_zk_proof_hex_data",
        merkleRoot,
        nullifierHash,
        commitmentHash,
        providerId: "provider_001",
        minStakeStroops: "100000000",
      },
    });

    expect(verifyRes.statusCode).toBe(200);
    const body = verifyRes.json();
    expect(body.verified).toBe(true);
    expect(body.minimumStakeMet).toBe(true);
  });

  it("returns 409 when nullifier is reused (double-spend prevention)", async () => {
    const commitmentHash = "f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5";
    const nullifierHash = "0718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6";

    await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake",
      payload: { commitmentHash, stakedAmountStroops: "500000000" },
    });

    const merkleRoot = getMerkleRoot();

    // First verification — should succeed
    const firstRes = await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake/verify",
      payload: {
        proof: "valid_zk_proof_hex_data",
        merkleRoot,
        nullifierHash,
        commitmentHash,
        providerId: "provider_001",
        minStakeStroops: "100000000",
      },
    });
    expect(firstRes.statusCode).toBe(200);

    // Second verification with same nullifier — should fail
    const secondRes = await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake/verify",
      payload: {
        proof: "valid_zk_proof_hex_data",
        merkleRoot,
        nullifierHash,
        commitmentHash,
        providerId: "provider_002",
        minStakeStroops: "100000000",
      },
    });
    expect(secondRes.statusCode).toBe(409);
    expect(secondRes.json().code).toBe("NULLIFIER_SPENT");
  });

  it("returns 422 for invalid proof", async () => {
    const commitmentHash = "18293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607";

    await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake",
      payload: { commitmentHash, stakedAmountStroops: "500000000" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake/verify",
      payload: {
        proof: "invalid_proof",
        merkleRoot: getMerkleRoot(),
        nullifierHash: "293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
        commitmentHash,
        providerId: "provider_001",
        minStakeStroops: "100000000",
      },
    });

    expect(res.statusCode).toBe(422);
  });

  it("returns commitment status via GET", async () => {
    const commitmentHash = "3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829";

    await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake",
      payload: { commitmentHash, stakedAmountStroops: "500000000" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/provider/shielded-stake/status/${commitmentHash}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.commitmentHash).toBe(commitmentHash);
    expect(body.isActive).toBe(true);
    expect(body.stakedAmountStroops).toBe("500000000");
  });

  it("returns current merkle root", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/provider/shielded-stake/merkle-root",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.merkleRoot).toBeDefined();
    expect(body.leafCount).toBe(0);
  });

  it("merkle root updates after deposits", async () => {
    const root1 = (await (await app.inject({ method: "GET", url: "/api/v1/provider/shielded-stake/merkle-root" })).json()).merkleRoot;

    await app.inject({
      method: "POST",
      url: "/api/v1/provider/shielded-stake",
      payload: {
        commitmentHash: "4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a",
        stakedAmountStroops: "500000000",
      },
    });

    const root2 = (await (await app.inject({ method: "GET", url: "/api/v1/provider/shielded-stake/merkle-root" })).json()).merkleRoot;

    expect(root2).not.toBe(root1);
  });
});
