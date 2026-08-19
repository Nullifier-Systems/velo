import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { zkSettleRoutes, inMemoryZkRegistry } from "../../apps/api/src/routes/zk-settle.js";

describe("ZK Nullifier Concurrency Stress Test (Issue #371)", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    inMemoryZkRegistry.clear();
    app = Fastify();
    await app.register(zkSettleRoutes, { prefix: "/api/v1" });
    await app.ready();
  });

  it("50 simultaneous POST requests with identical nullifier hash yield 1x 202 and 49x 409", async () => {
    const nullifierHash = "d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3";
    const commitment = "c6b5a4039281706f5e4d3c2b1a0f9e8d7c6b5a4039281706f5e4d3c2b1f9e8d7";

    const requests = Array.from({ length: 50 }).map(() =>
      app.inject({
        method: "POST",
        url: "/api/v1/cash/zk-settle",
        payload: {
          proof: "concurrent_test_proof",
          nullifierHash,
          commitment,
        },
      })
    );

    const responses = await Promise.all(requests);
    const statusCodes = responses.map((r) => r.statusCode);

    const count202 = statusCodes.filter((code) => code === 202).length;
    const count409 = statusCodes.filter((code) => code === 409).length;

    expect(count202).toBe(1);
    expect(count409).toBe(49);
  });
});
