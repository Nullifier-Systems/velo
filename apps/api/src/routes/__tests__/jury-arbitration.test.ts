import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { juryArbitrationRoutes } from "../jury-arbitration.js";
import { panelStore, voteCommitStore, voteRevealStore } from "../../lib/workers/disputeArbitrationWorker.js";

describe("Jury Arbitration Routes (Issue #404)", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    panelStore.clear();
    voteCommitStore.clear();
    voteRevealStore.clear();
    app = Fastify();
    await app.register(juryArbitrationRoutes, { prefix: "/api/v1" });
    await app.ready();
  });

  const jurorAddresses = Array.from({ length: 5 }, () =>
    "G" + Array.from({ length: 55 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(Math.random() * 32)]).join(""),
  );

  async function createPanel() {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/jury/panels",
      payload: {
        tradeId: "a".repeat(64),
        escrowAmountStroops: "1000000000",
        jurorAddresses,
        ledgerSequence: 1000,
      },
    });
    return res.json();
  }

  it("returns 201 on panel creation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/jury/panels",
      payload: {
        tradeId: "a".repeat(64),
        escrowAmountStroops: "1000000000",
        jurorAddresses,
        ledgerSequence: 1000,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.panelId).toBeDefined();
    expect(body.jurorAddresses).toHaveLength(5);
    expect(body.status).toBe("VOTING");
  });

  it("returns 400 if jurorAddresses count is wrong", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/jury/panels",
      payload: {
        tradeId: "a".repeat(64),
        escrowAmountStroops: "1000000000",
        jurorAddresses: jurorAddresses.slice(0, 3),
        ledgerSequence: 1000,
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("accepts vote commit from panel juror", async () => {
    const panel = await createPanel();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/jury/vote-commit",
      payload: {
        panelId: panel.panelId,
        jurorAddress: jurorAddresses[0],
        commitHash: "a".repeat(64),
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().phase).toBe("COMMIT");
  });

  it("returns 409 for duplicate vote commit", async () => {
    const panel = await createPanel();

    await app.inject({
      method: "POST",
      url: "/api/v1/jury/vote-commit",
      payload: {
        panelId: panel.panelId,
        jurorAddress: jurorAddresses[0],
        commitHash: "a".repeat(64),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/jury/vote-commit",
      payload: {
        panelId: panel.panelId,
        jurorAddress: jurorAddresses[0],
        commitHash: "b".repeat(64),
      },
    });

    expect(res.statusCode).toBe(409);
  });

  it("returns 404 for non-existent panel", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/jury/vote-commit",
      payload: {
        panelId: "nonexistent",
        jurorAddress: jurorAddresses[0],
        commitHash: "a".repeat(64),
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for juror not on panel", async () => {
    const panel = await createPanel();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/jury/vote-commit",
      payload: {
        panelId: panel.panelId,
        jurorAddress: "G" + "X".repeat(55),
        commitHash: "a".repeat(64),
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("gets panel details via GET", async () => {
    const panel = await createPanel();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/jury/panels/${panel.panelId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.panelId).toBe(panel.panelId);
    expect(body.status).toBe("VOTING");
    expect(body.commitsReceived).toBe(0);
  });
});
