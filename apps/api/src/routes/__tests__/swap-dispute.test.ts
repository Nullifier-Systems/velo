import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { createHash, randomBytes } from "crypto";
import { swapDisputeRoutes } from "../swap-dispute.js";
import {
  SwapDisputeStore,
  memorySwapDisputeStore,
} from "../../lib/workers/swapDisputeWorker.js";

describe("Swap Dispute Bridge Routes (Issue #446)", () => {
  let app: ReturnType<typeof Fastify>;
  let store: SwapDisputeStore;

  beforeEach(async () => {
    memorySwapDisputeStore.clear();
    store = new SwapDisputeStore();
    app = Fastify();
    await app.register(swapDisputeRoutes, { prefix: "/api/v1", store });
    await app.ready();
  });

  function generatePreimageAndHash(): { preimage: string; secretHash: string } {
    const preimageBytes = randomBytes(32);
    const preimage = preimageBytes.toString("hex");
    const secretHash = createHash("sha256").update(preimageBytes).digest("hex");
    return { preimage, secretHash };
  }

  it("POST /api/v1/swaps/register-dispute registers a new dispute bridge record", async () => {
    const { secretHash } = generatePreimageAndHash();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/swaps/register-dispute",
      payload: {
        swapId: "swap-test-1",
        initiatorAddress: "GAINITIATOR00000000000000000000000000000000000000000000",
        counterpartyAddress: "GBCOUNTERPARTY000000000000000000000000000000000000000000",
        secretHash,
        expirationLedger: 5000,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.swapId).toBe("swap-test-1");
    expect(body.state).toBe("ACTIVE");
    expect(body.expirationLedger).toBe(5000);
  });

  it("POST /api/v1/swaps/extract-secret extracts valid preimage and updates state", async () => {
    const { preimage, secretHash } = generatePreimageAndHash();
    await store.registerBridge({
      swapId: "swap-test-extract",
      initiatorAddress: "GAINITIATOR00000000000000000000000000000000000000000000",
      counterpartyAddress: "GBCOUNTERPARTY000000000000000000000000000000000000000000",
      secretHash,
      expirationLedger: 5000,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/swaps/extract-secret",
      payload: {
        swapId: "swap-test-extract",
        secretPreimage: preimage,
        chain: "ethereum",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("SECRET_EXTRACTED");
    expect(body.secretPreimage).toBe(preimage);
    expect(body.updated).toBe(true);
  });

  it("POST /api/v1/swaps/dispute-claim resolves secret when preimage is present", async () => {
    const { preimage, secretHash } = generatePreimageAndHash();
    await store.registerBridge({
      swapId: "swap-claim-secret",
      initiatorAddress: "GAINITIATOR00000000000000000000000000000000000000000000",
      counterpartyAddress: "GBCOUNTERPARTY000000000000000000000000000000000000000000",
      secretHash,
      expirationLedger: 5000,
    });

    await store.extractSecretPreimage("swap-claim-secret", preimage, "stellar");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/swaps/dispute-claim",
      payload: {
        swapId: "swap-claim-secret",
        currentLedger: 4500,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.state).toBe("RESOLVED");
    expect(body.action).toBe("RESOLVED_SECRET");
    expect(body.executionProof).toBeDefined();
    expect(body.secretPreimage).toBe(preimage);
  });

  it("POST /api/v1/swaps/dispute-claim triggers automatic refund when expired", async () => {
    const { secretHash } = generatePreimageAndHash();
    await store.registerBridge({
      swapId: "swap-claim-refund",
      initiatorAddress: "GAINITIATOR00000000000000000000000000000000000000000000",
      counterpartyAddress: "GBCOUNTERPARTY000000000000000000000000000000000000000000",
      secretHash,
      expirationLedger: 5000,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/swaps/dispute-claim",
      payload: {
        swapId: "swap-claim-refund",
        currentLedger: 5001,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.state).toBe("RESOLVED");
    expect(body.action).toBe("REFUNDED_TIMEOUT");
    expect(body.executionProof).toContain("proof_refund_swap-claim-refund_ledger_5001");
  });

  it("GET /api/v1/swaps/dispute/:swapId returns 404 for unknown swap", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/swaps/dispute/unknown-swap-id",
    });

    expect(res.statusCode).toBe(404);
  });
});
