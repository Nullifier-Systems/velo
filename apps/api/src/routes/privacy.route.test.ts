import { describe, expect, it, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { cashRoutes } from "./cash.js";
import { saveProvider, saveCashRequest } from "../lib/store.js";

vi.mock("../lib/stellar.js", () => ({
  lockEscrow: vi.fn().mockResolvedValue(undefined),
  releaseEscrow: vi.fn().mockResolvedValue(undefined),
  refundEscrow: vi.fn().mockResolvedValue(undefined),
  disputeEscrow: vi.fn().mockResolvedValue(undefined),
  resolveEscrow: vi.fn().mockResolvedValue(undefined),
  buildLockEscrowTransaction: vi.fn().mockResolvedValue("dummy_unsigned_xdr"),
  submitSignedTransaction: vi.fn().mockResolvedValue({ hash: "h", status: "SUCCESS" }),
  submitReleaseTx: vi.fn().mockResolvedValue({ hash: "h" }),
  submitRefundTx: vi.fn().mockResolvedValue({ hash: "h" }),
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  CONTRACTS: { testnet: { escrow: "dummy_contract" } },
}));

const SELLER = "GSELLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("privacy-preserving proximity matching", () => {
  let app: any;

  beforeEach(() => {
    vi.clearAllMocks();
    app = Fastify();
    app.decorate("requirePayment", async () => true);
    app.register(cashRoutes, { prefix: "/api/v1" });

    saveProvider({
      id: "prov-1",
      stellarAddress: SELLER,
      name: "Test Provider",
      lat: 6.52447,
      lng: 3.37921,
      tier: "Standard",
      rate: "1.0",
      status: "available",
      kycStatus: "approved",
      createdAt: new Date().toISOString(),
    });
  });

  it("GET /cash/agents returns coarse cells, never exact coordinates", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cash/agents?lat=6.6&lng=3.4&radius=50",
      headers: { "x-payment": "ok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents.length).toBeGreaterThan(0);
    const agent = body.agents.find((a: any) => a.id === "prov-1");
    expect(agent).toBeTruthy();
    expect(agent.geohash).toBeTruthy();
    expect(agent.distance_band).toBeTruthy();
    // No exact location anywhere in the discovery response.
    expect(agent.lat).toBeUndefined();
    expect(agent.lng).toBeUndefined();
    expect(agent.distance_km).toBeUndefined();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("6.52447");
    expect(raw).not.toContain("3.37921");
    expect(body.privacy.precision).toBeGreaterThanOrEqual(4);
    expect(body.availability).toEqual({ state: "available" });
  });

  it("returns a deliberate cold-start state when no providers are nearby", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cash/agents?lat=-80&lng=0&radius=1",
      headers: { "x-payment": "ok" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      agents: [],
      availability: {
        state: "no_providers_nearby",
        suggested_action: "check_back_later",
        retry_after_seconds: 3600,
      },
    });
    expect(res.json().availability.message).toContain(
      "no approved cash providers nearby",
    );
  });

  it("keeps invalid discovery requests distinct from a cold start", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cash/agents?lat=not-a-number&lng=0",
      headers: { "x-payment": "ok" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
    expect(res.json()).not.toHaveProperty("availability");
  });

  it("does not reveal a provider location without a confirmed match", async () => {
    saveCashRequest({
      id: "trade-pending",
      contractId: "c",
      seller: SELLER,
      buyer: "GBUYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amountStroops: "1",
      secretHex: "",
      secretHashHex: "a".repeat(64),
      qrPayload: "q",
      status: "pending_signature",
      createdAt: new Date().toISOString(),
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cash/request/trade-pending/provider-location",
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain("6.52447");
  });

  it("reveals exact coordinates only once the escrow is locked (a match)", async () => {
    saveCashRequest({
      id: "trade-locked",
      contractId: "c",
      seller: SELLER,
      buyer: "GBUYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amountStroops: "1",
      secretHex: "",
      secretHashHex: "a".repeat(64),
      qrPayload: "q",
      status: "locked",
      createdAt: new Date().toISOString(),
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cash/request/trade-locked/provider-location",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lat).toBe(6.52447);
    expect(body.lng).toBe(3.37921);
    expect(body.provider_id).toBe("prov-1");
  });

  it("returns 404 for an unknown trade", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cash/request/does-not-exist/provider-location",
    });
    expect(res.statusCode).toBe(404);
  });
});
