import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { zkSettleRoutes, inMemoryZkRegistry } from "../zk-settle.js";

describe("ZK Settle Routes (Issue #371)", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    inMemoryZkRegistry.clear();
    app = Fastify();
    await app.register(zkSettleRoutes, { prefix: "/api/v1" });
    await app.ready();
  });

  it("returns 202 Accepted on valid settlement submission", async () => {
    const nullifierHash = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const commitment = "f9e8d7c6b5a4039281706f5e4d3c2b1a0f9e8d7c6b5a4039281706f5e4d3c2b1";

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cash/zk-settle",
      payload: {
        proof: "valid_zk_proof_hex_bytes_12345",
        nullifierHash,
        commitment,
        credentialSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("PENDING");
    expect(body.nullifierHash).toBe(nullifierHash);

    // Verify raw credential secret is NOT stored in registry
    const stored = inMemoryZkRegistry.get(nullifierHash);
    expect(stored).toBeDefined();
    expect((stored as any).credentialSecret).toBeUndefined();
  });

  it("returns 422 Unprocessable Entity for invalid proof", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cash/zk-settle",
      payload: {
        proof: "invalid_proof",
        nullifierHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
        commitment: "f9e8d7c6b5a4039281706f5e4d3c2b1a0f9e8d7c6b5a4039281706f5e4d3c2b1",
      },
    });

    expect(res.statusCode).toBe(422);
  });

  it("returns 409 Conflict when nullifier hash is already present", async () => {
    const nullifierHash = "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1";
    const commitment = "e8d7c6b5a4039281706f5e4d3c2b1a0f9e8d7c6b5a4039281706f5e4d3c2b1f9";

    await app.inject({
      method: "POST",
      url: "/api/v1/cash/zk-settle",
      payload: { proof: "valid_proof", nullifierHash, commitment },
    });

    const secondRes = await app.inject({
      method: "POST",
      url: "/api/v1/cash/zk-settle",
      payload: { proof: "valid_proof", nullifierHash, commitment },
    });

    expect(secondRes.statusCode).toBe(409);
  });

  it("returns status via GET /api/v1/cash/zk-settle/status/:nullifierHash", async () => {
    const nullifierHash = "c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2";
    const commitment = "d7c6b5a4039281706f5e4d3c2b1a0f9e8d7c6b5a4039281706f5e4d3c2b1f9e8";

    await app.inject({
      method: "POST",
      url: "/api/v1/cash/zk-settle",
      payload: { proof: "valid_proof", nullifierHash, commitment },
    });

    const statusRes = await app.inject({
      method: "GET",
      url: `/api/v1/cash/zk-settle/status/${nullifierHash}`,
    });

    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().status).toBe("PENDING");
  });
});
