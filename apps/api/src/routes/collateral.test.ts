import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { collateralRoutes } from "./collateral.js";
import { CollateralGuardStore } from "../lib/collateralGuard.js";

vi.mock("../lib/stellar.js", () => ({
  getLatestLedgerSequence: vi.fn(async () => 10_000),
}));

async function buildApp(store = new CollateralGuardStore()) {
  const app = Fastify();
  await app.register(rateLimit);
  await app.register(collateralRoutes, {
    prefix: "/api/v1",
    store,
    getCurrentLedger: async () => 10_000,
  });
  await app.ready();
  return app;
}

describe("POST /api/v1/cash/collateral/release-check (#420)", () => {
  let app: ReturnType<typeof buildApp> extends Promise<infer T> ? T : never;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedDeposit(depositLedger: number) {
    const store = new CollateralGuardStore();
    await store.recordDeposit({
      providerId: "prov-1",
      assetAddress: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZ4MWQ5VBSNFYQ2YL",
      amountStroops: "1000000",
      depositLedger,
    });
    return store;
  }

  it("returns HTTP 409 with the exact FLASH_LOAN_COOLDOWN_ACTIVE shape while locked", async () => {
    const cooldownApp = await buildApp(await seedDeposit(9_998));
    const res = await cooldownApp.inject({
      method: "POST",
      url: "/api/v1/cash/collateral/release-check",
      payload: { provider_id: "prov-1" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toEqual({
      code: "FLASH_LOAN_COOLDOWN_ACTIVE",
      message:
        "Collateral cannot be released in the same ledger sequence. Minimum 5-ledger lockup required.",
      requestId: expect.any(String),
    });
    // Additive metadata for dashboards.
    expect(body.remaining_ledgers).toBe(3);
    expect(body.earliest_release_ledger).toBe(10_003);
    await cooldownApp.close();
  });

  it("rejects a same-ledger release (deposit and check in one ledger)", async () => {
    const store = new CollateralGuardStore();
    await store.recordDeposit({
      providerId: "prov-1",
      assetAddress: "A",
      amountStroops: "1",
      depositLedger: 10_000,
    });
    const sameLedgerApp = await buildApp(store);

    const res = await sameLedgerApp.inject({
      method: "POST",
      url: "/api/v1/cash/collateral/release-check",
      payload: { provider_id: "prov-1" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("FLASH_LOAN_COOLDOWN_ACTIVE");
    expect(res.json().remaining_ledgers).toBe(5);
    await sameLedgerApp.close();
  });

  it("returns HTTP 200 once the 5-ledger lockup has elapsed", async () => {
    const okApp = await buildApp(await seedDeposit(9_995));
    const res = await okApp.inject({
      method: "POST",
      url: "/api/v1/cash/collateral/release-check",
      payload: { provider_id: "prov-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      eligible: true,
      provider_id: "prov-1",
      current_ledger: 10_000,
      deposits_checked: 1,
      remaining_ledgers: 0,
    });
    await okApp.close();
  });

  it("is eligible when the provider has no locked deposits", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cash/collateral/release-check",
      payload: { provider_id: "unknown-provider" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ eligible: true, deposits_checked: 0 });
  });

  it("honors an explicit release_ledger instead of fetching the chain tip", async () => {
    const explicitApp = await buildApp(await seedDeposit(100));
    const blocked = await explicitApp.inject({
      method: "POST",
      url: "/api/v1/cash/collateral/release-check",
      payload: { provider_id: "prov-1", release_ledger: 103 },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().current_ledger).toBe(103);

    const allowed = await explicitApp.inject({
      method: "POST",
      url: "/api/v1/cash/collateral/release-check",
      payload: { provider_id: "prov-1", release_ledger: 105 },
    });
    expect(allowed.statusCode).toBe(200);
    await explicitApp.close();
  });

  it("validates the body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cash/collateral/release-check",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("translates ledger-source failures into a 502", async () => {
    const failingApp = Fastify();
    await failingApp.register(rateLimit);
    await failingApp.register(collateralRoutes, {
      prefix: "/api/v1",
      store: new CollateralGuardStore(),
      getCurrentLedger: async () => {
        throw new Error("rpc down");
      },
    });
    await failingApp.ready();

    const res = await failingApp.inject({
      method: "POST",
      url: "/api/v1/cash/collateral/release-check",
      payload: { provider_id: "prov-1" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("LEDGER_UNAVAILABLE");
    await failingApp.close();
  });
});
