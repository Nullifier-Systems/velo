import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { batchAuctionRoutes } from "../batch-auctions.js";
import { computeCommitHash } from "../../lib/batch-auction-engine.js";
import { resetBatchAuctionStore, setRoundPhase } from "../../lib/encrypted-order-store.js";

async function buildApp(opts: { commitMs?: number; revealMs?: number } = {}) {
  const app = Fastify();
  await app.register(batchAuctionRoutes, { prefix: "/api/v1", ...opts });
  await app.ready();
  return app;
}

describe("batch auction commit-reveal endpoints (#403)", () => {
  beforeEach(() => {
    resetBatchAuctionStore();
  });

  afterEach(() => {
    resetBatchAuctionStore();
  });

  it("commits an order and returns its orderId + round", async () => {
    const app = await buildApp();
    const commitHash = computeCommitHash({
      side: "BUY",
      rateStroops: "100",
      amountStroops: "1000",
      saltHex: "deadbeef",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auctions/commit",
      payload: { commitHash, depositAmountStroops: "50" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.data.orderId).toBeTruthy();
    expect(body.data.phase).toBe("COMMIT");
    await app.close();
  });

  it("rejects a malformed commit hash", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auctions/commit",
      payload: { commitHash: "not-a-hash", depositAmountStroops: "50" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("reveals an order that matches its commitment", async () => {
    const app = await buildApp({ commitMs: 60_000, revealMs: 60_000 });
    const order = { side: "BUY" as const, rateStroops: "100", amountStroops: "1000", saltHex: "deadbeef" };
    const commitHash = computeCommitHash(order);

    const commitRes = await app.inject({
      method: "POST",
      url: "/api/v1/auctions/commit",
      payload: { commitHash, depositAmountStroops: "50" },
    });
    const { orderId, roundId } = commitRes.json().data;

    const revealDuringCommit = await app.inject({
      method: "POST",
      url: "/api/v1/auctions/reveal",
      payload: { orderId, roundId, ...order },
    });
    expect(revealDuringCommit.statusCode).toBe(409);
    expect(revealDuringCommit.json().code).toBe("REVEAL_PHASE_CLOSED");

    // Advance the round to REVEAL (this is what batchAuctionWorker.ts does
    // once the commit deadline passes) and confirm a matching reveal is
    // accepted, while a tampered one is rejected as a commit mismatch.
    setRoundPhase(roundId, "REVEAL");

    const mismatchReveal = await app.inject({
      method: "POST",
      url: "/api/v1/auctions/reveal",
      payload: { orderId, roundId, ...order, amountStroops: "9999" },
    });
    expect(mismatchReveal.statusCode).toBe(400);
    expect(mismatchReveal.json().code).toBe("COMMIT_MISMATCH");

    const validReveal = await app.inject({
      method: "POST",
      url: "/api/v1/auctions/reveal",
      payload: { orderId, roundId, ...order },
    });
    expect(validReveal.statusCode).toBe(200);

    const doubleReveal = await app.inject({
      method: "POST",
      url: "/api/v1/auctions/reveal",
      payload: { orderId, roundId, ...order },
    });
    expect(doubleReveal.statusCode).toBe(409);
    expect(doubleReveal.json().code).toBe("ALREADY_REVEALED");

    await app.close();
  });

  it("reports the current round phase and clearing price on /auctions/state", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/auctions/state" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.roundId).toBeTruthy();
    expect(body.data.phase).toBe("COMMIT");
    expect(body.data.clearingPriceStroops).toBeNull();
    await app.close();
  });

  it("rejects a reveal for an unknown round", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auctions/reveal",
      payload: {
        orderId: "00000000-0000-0000-0000-000000000000",
        roundId: "nonexistent-round",
        side: "BUY",
        rateStroops: "100",
        amountStroops: "1000",
        saltHex: "deadbeef",
      },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
