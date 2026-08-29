import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { juryArbitrationRoutes } from "../../apps/api/src/routes/jury-arbitration.js";
import { panelStore, voteCommitStore, voteRevealStore } from "../../apps/api/src/lib/workers/disputeArbitrationWorker.js";

describe("Jury Voting Concurrency Stress Test (Issue #404)", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    panelStore.clear();
    voteCommitStore.clear();
    voteRevealStore.clear();
    app = Fastify();
    await app.register(juryArbitrationRoutes, { prefix: "/api/v1" });
    await app.ready();
  });

  function makeJurorAddress(index: number): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let addr = "G";
    for (let i = 0; i < 55; i++) {
      addr += chars[(index * 31 + i * 17) % 32];
    }
    return addr;
  }

  it("50 simultaneous vote commits with same juror yield 1x 201 and 49x 409", async () => {
    const jurorAddresses = Array.from({ length: 5 }, (_, i) => makeJurorAddress(i));

    // Create panel first
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/jury/panels",
      payload: {
        tradeId: "stress_test_trade" + "0".repeat(48),
        escrowAmountStroops: "1000000000",
        jurorAddresses,
        ledgerSequence: 50000,
      },
    });
    const { panelId } = createRes.json();

    // 50 simultaneous commits with same juror address
    const requests = Array.from({ length: 50 }).map(() =>
      app.inject({
        method: "POST",
        url: "/api/v1/jury/vote-commit",
        payload: {
          panelId,
          jurorAddress: jurorAddresses[0],
          commitHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
        },
      }),
    );

    const responses = await Promise.all(requests);
    const statusCodes = responses.map((r) => r.statusCode);

    const count201 = statusCodes.filter((code) => code === 201).length;
    const count409 = statusCodes.filter((code) => code === 409).length;

    expect(count201).toBe(1);
    expect(count409).toBe(49);
  });

  it("concurrent reveals from different jurors all succeed", async () => {
    const jurorAddresses = Array.from({ length: 5 }, (_, i) => makeJurorAddress(i + 5));

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/jury/panels",
      payload: {
        tradeId: "concurrent_reveal_trade" + "0".repeat(42),
        escrowAmountStroops: "1000000000",
        jurorAddresses,
        ledgerSequence: 50001,
      },
    });
    const { panelId } = createRes.json();

    // Commit for all jurors
    const { createHash } = await import("node:crypto");
    const salts: string[] = [];
    for (let i = 0; i < 5; i++) {
      const salt = createHash("sha256").update(`juror${i}`).digest("hex");
      salts.push(salt);
      const vote = i < 3 ? "BUYER" : "SELLER";
      const commitHash = createHash("sha256").update(`${vote}:${salt}`).digest("hex");

      await app.inject({
        method: "POST",
        url: "/api/v1/jury/vote-commit",
        payload: { panelId, jurorAddress: jurorAddresses[i], commitHash },
      });
    }

    // Start reveal phase
    await app.inject({ method: "POST", url: `/api/v1/jury/panels/${panelId}/start-reveal` });

    // Concurrent reveals
    const revealRequests = Array.from({ length: 5 }).map((_, i) => {
      const vote = i < 3 ? "BUYER" : "SELLER";
      return app.inject({
        method: "POST",
        url: "/api/v1/jury/vote-reveal",
        payload: {
          panelId,
          jurorAddress: jurorAddresses[i],
          vote,
          saltHex: salts[i],
        },
      });
    });

    const revealResponses = await Promise.all(revealRequests);
    const revealCodes = revealResponses.map((r) => r.statusCode);

    // All should succeed (201) since each juror is unique
    expect(revealCodes.every((c) => c === 201)).toBe(true);

    // Panel should be resolved after all reveals
    const finalPanel = panelStore.get(panelId)!;
    expect(finalPanel.status).toBe("RESOLVED");
    expect(finalPanel.resolution).toBe("BUYER");
  });
});
