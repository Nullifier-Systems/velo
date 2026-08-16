import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreakerStore } from "../lib/circuit-breaker-store.js";

vi.mock("../lib/stellar.js", () => ({
  broadcastCircuitBreakerPause: vi.fn(),
}));

import { circuitBreakerRoutes } from "./circuit-breaker.js";

const VALID_CONTRACT = "C".padEnd(56, "a");

describe("circuit-breaker admin endpoints (#374)", () => {
  const adminKey = "test-cb-admin-key";

  beforeEach(() => {
    process.env.ADMIN_API_KEY = adminKey;
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    vi.restoreAllMocks();
  });

  function seedState(store: CircuitBreakerStore, status: "HEALTHY" | "HALTED" = "HEALTHY") {
    void store.upsertState({
      contractId: VALID_CONTRACT,
      totalLockedStroops: 1_000_000n,
      totalAllocatedStroops: 0n,
      feeAccumulatorStroops: 0n,
      lastProcessedLedger: 49281901,
      status,
    });
  }

  async function buildApp(options: { store?: CircuitBreakerStore; broadcast?: () => Promise<{ hash: string }> } = {}) {
    const app = Fastify();
    await app.register(circuitBreakerRoutes, {
      prefix: "/api/v1",
      store: options.store,
      broadcast: options.broadcast as any,
    });
    await app.ready();
    return app;
  }

  it("rejects requests without an admin key (401)", async () => {
    const store = new CircuitBreakerStore();
    seedState(store);
    const app = await buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/circuit-breaker/override",
      payload: { contractId: VALID_CONTRACT, action: "FORCE_PAUSE", reason: "manual halt" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("UNAUTHORIZED_ADMIN");
    await app.close();
  });

  it("rejects with 503 when the admin key is not configured", async () => {
    delete process.env.ADMIN_API_KEY;
    const store = new CircuitBreakerStore();
    const app = await buildApp({ store });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/circuit-breaker/state?contractId=" + VALID_CONTRACT,
      headers: { "x-admin-api-key": adminKey },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("CONFIG_ERROR");
    await app.close();
  });

  it("forces a pause and records the broadcast tx hash", async () => {
    const store = new CircuitBreakerStore();
    seedState(store);
    const broadcast = vi.fn().mockResolvedValue({ hash: "txhash-123" });
    const app = await buildApp({ store, broadcast });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/circuit-breaker/override",
      headers: { "x-admin-api-key": adminKey, "x-admin-operator-name": "ops-bot" },
      payload: { contractId: VALID_CONTRACT, action: "FORCE_PAUSE", reason: "manual halt now" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("success");
    expect(body.txHash).toBe("txhash-123");
    expect(body.newStatus).toBe("HALTED");
    expect(broadcast).toHaveBeenCalledWith({
      contractId: VALID_CONTRACT,
      action: "FORCE_PAUSE",
    });
    expect((await store.get(VALID_CONTRACT))?.status).toBe("HALTED");

    const incidents = await store.incidents(VALID_CONTRACT);
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents[0].violatedInvariant).toBe("ADMIN_OVERRIDE:FORCE_PAUSE");
    expect(incidents[0].txPauseHash).toBe("txhash-123");
    await app.close();
  });

  it("unpauses a halted contract", async () => {
    const store = new CircuitBreakerStore();
    seedState(store, "HALTED");
    const broadcast = vi.fn().mockResolvedValue({ hash: "txhash-unpause" });
    const app = await buildApp({ store, broadcast });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/circuit-breaker/override",
      headers: { "x-admin-api-key": adminKey },
      payload: { contractId: VALID_CONTRACT, action: "UNPAUSE", reason: "manual resume now" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().newStatus).toBe("HEALTHY");
    expect((await store.get(VALID_CONTRACT))?.status).toBe("HEALTHY");
    await app.close();
  });

  it("rejects a redundant override with 409 STATE_ALREADY_SET", async () => {
    const store = new CircuitBreakerStore();
    seedState(store, "HALTED");
    const app = await buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/circuit-breaker/override",
      headers: { "x-admin-api-key": adminKey },
      payload: { contractId: VALID_CONTRACT, action: "FORCE_PAUSE", reason: "again but already halted" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("STATE_ALREADY_SET");
    await app.close();
  });

  it("returns 404 for an unknown contract", async () => {
    const store = new CircuitBreakerStore();
    const app = await buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/circuit-breaker/override",
      headers: { "x-admin-api-key": adminKey },
      payload: { contractId: VALID_CONTRACT, action: "FORCE_PAUSE", reason: "never seen this one" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("NOT_FOUND");
    await app.close();
  });

  it("validates the payload (contract id length, action, reason)", async () => {
    const store = new CircuitBreakerStore();
    seedState(store);
    const app = await buildApp({ store });

    const tooShort = await app.inject({
      method: "POST",
      url: "/api/v1/admin/circuit-breaker/override",
      headers: { "x-admin-api-key": adminKey },
      payload: { contractId: "C-short", action: "FORCE_PAUSE", reason: "valid reason here" },
    });
    expect(tooShort.statusCode).toBe(400);

    const badAction = await app.inject({
      method: "POST",
      url: "/api/v1/admin/circuit-breaker/override",
      headers: { "x-admin-api-key": adminKey },
      payload: { contractId: VALID_CONTRACT, action: "EXPLODE", reason: "valid reason here" },
    });
    expect(badAction.statusCode).toBe(400);

    const shortReason = await app.inject({
      method: "POST",
      url: "/api/v1/admin/circuit-breaker/override",
      headers: { "x-admin-api-key": adminKey },
      payload: { contractId: VALID_CONTRACT, action: "FORCE_PAUSE", reason: "short" },
    });
    expect(shortReason.statusCode).toBe(400);
    await app.close();
  });

  it("returns 502 when the on-chain broadcast fails", async () => {
    const store = new CircuitBreakerStore();
    seedState(store);
    const broadcast = vi.fn().mockRejectedValue(new Error("network down"));
    const app = await buildApp({ store, broadcast });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/circuit-breaker/override",
      headers: { "x-admin-api-key": adminKey },
      payload: { contractId: VALID_CONTRACT, action: "FORCE_PAUSE", reason: "broadcast will fail" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("TX_SUBMIT_FAILED");
    await app.close();
  });

  it("lists incidents filtered by contract", async () => {
    const store = new CircuitBreakerStore();
    seedState(store);
    await store.logIncident({
      contractId: VALID_CONTRACT,
      violatedInvariant: "INV-07_RESERVE_CONSERVATION",
      evidence: { drift: "1000" },
      actionTaken: "PAUSE_SINGLE_ESCROW",
      txPauseHash: "tx-a",
    });
    const app = await buildApp({ store });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/circuit-breaker/incidents?contractId=" + VALID_CONTRACT,
      headers: { "x-admin-api-key": adminKey },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().count).toBe(1);
    expect(response.json().data[0].violatedInvariant).toBe("INV-07_RESERVE_CONSERVATION");
    await app.close();
  });

  it("returns the invariant state snapshot", async () => {
    const store = new CircuitBreakerStore();
    seedState(store);
    const app = await buildApp({ store });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/circuit-breaker/state?contractId=" + VALID_CONTRACT,
      headers: { "x-admin-api-key": adminKey },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      contractId: VALID_CONTRACT,
      status: "HEALTHY",
      lastProcessedLedger: 49281901,
    });
    expect(response.json().data.totalLockedStroops).toBe("1000000");
    await app.close();
  });
});
