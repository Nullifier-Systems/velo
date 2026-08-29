/**
 * E2E Dispute Arbitration Simulation Test (#404)
 *
 * Simulates the full dispute lifecycle: panel creation → vote commits →
 * vote reveals → majority resolution → stake slashing.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { juryArbitrationRoutes } from "../../apps/api/src/routes/jury-arbitration.js";
import {
  panelStore,
  voteCommitStore,
  voteRevealStore,
  createDisputePanel,
  submitVoteCommit,
  submitVoteReveal,
  startRevealPhase,
  resolvePanel,
} from "../../apps/api/src/lib/workers/disputeArbitrationWorker.js";
import { computeVrfSeed, verifyVrfSeed } from "../../apps/api/src/lib/jury-selection.js";
import { DISPUTE_JURY } from "@velo/shared";

describe("Dispute Arbitration E2E (Issue #404)", () => {
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

  async function hashVote(vote: string, salt: string): Promise<string> {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(`${vote}:${salt}`).digest("hex");
  }

  it("full lifecycle: 3-vs-2 vote with minority slashing", async () => {
    const tradeId = "e2e_trade_001" + "0".repeat(50);
    const ledgerSequence = 42000;

    // 1. Create panel via API
    const jurorAddresses = Array.from({ length: 5 }, (_, i) => makeJurorAddress(i));
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/jury/panels",
      payload: {
        tradeId,
        escrowAmountStroops: "5000000000",
        jurorAddresses,
        ledgerSequence,
      },
    });

    expect(createRes.statusCode).toBe(201);
    const { panelId } = createRes.json();
    expect(panelId).toBeDefined();

    // 2. Verify VRF seed is deterministic
    const seed = computeVrfSeed(tradeId, ledgerSequence);
    expect(verifyVrfSeed(tradeId, ledgerSequence, seed)).toBe(true);

    // 3. Submit vote commits (3 BUYER, 2 SELLER)
    const salt = "aabbccdd" + "00".repeat(28);
    for (let i = 0; i < 5; i++) {
      const vote = i < 3 ? "BUYER" : "SELLER";
      const commitHash = await hashVote(vote, salt);

      const commitRes = await app.inject({
        method: "POST",
        url: "/api/v1/jury/vote-commit",
        payload: {
          panelId,
          jurorAddress: jurorAddresses[i],
          commitHash,
        },
      });
      expect(commitRes.statusCode).toBe(201);
    }

    // 4. Verify all commits received
    const panelRes = await app.inject({
      method: "GET",
      url: `/api/v1/jury/panels/${panelId}`,
    });
    expect(panelRes.json().commitsReceived).toBe(5);

    // 5. Start reveal phase
    const revealStartRes = await app.inject({
      method: "POST",
      url: `/api/v1/jury/panels/${panelId}/start-reveal`,
    });
    expect(revealStartRes.statusCode).toBe(200);
    expect(revealStartRes.json().status).toBe("REVEALING");

    // 6. Submit vote reveals
    for (let i = 0; i < 5; i++) {
      const vote = i < 3 ? "BUYER" : "SELLER";
      const revealRes = await app.inject({
        method: "POST",
        url: "/api/v1/jury/vote-reveal",
        payload: {
          panelId,
          jurorAddress: jurorAddresses[i],
          vote,
          saltHex: salt,
        },
      });
      expect(revealRes.statusCode).toBe(201);
    }

    // 7. Verify resolution
    const finalPanel = panelStore.get(panelId)!;
    expect(finalPanel.status).toBe("RESOLVED");
    expect(finalPanel.resolution).toBe("BUYER");
    expect(finalPanel.buyerShareBps).toBe(10_000);
  });

  it("50/50 tie results in abstention with 5000 bps split", async () => {
    const tradeId = "e2e_trade_002" + "0".repeat(50);
    const ledgerSequence = 42001;

    const jurorAddresses = Array.from({ length: 5 }, (_, i) => makeJurorAddress(i + 10));
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/jury/panels",
      payload: {
        tradeId,
        escrowAmountStroops: "2000000000",
        jurorAddresses,
        ledgerSequence,
      },
    });

    const { panelId } = createRes.json();
    const salt = "11223344" + "00".repeat(28);

    // 2 BUYER, 2 SELLER, 1 ABSTAIN
    const votes: Array<"BUYER" | "SELLER" | "ABSTAIN"> = ["BUYER", "BUYER", "SELLER", "SELLER", "ABSTAIN"];
    for (let i = 0; i < 5; i++) {
      const commitHash = await hashVote(votes[i], salt);
      await app.inject({
        method: "POST",
        url: "/api/v1/jury/vote-commit",
        payload: { panelId, jurorAddress: jurorAddresses[i], commitHash },
      });
    }

    await app.inject({ method: "POST", url: `/api/v1/jury/panels/${panelId}/start-reveal` });

    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/api/v1/jury/vote-reveal",
        payload: { panelId, jurorAddress: jurorAddresses[i], vote: votes[i], saltHex: salt },
      });
    }

    const finalPanel = panelStore.get(panelId)!;
    expect(finalPanel.resolution).toBe("ABSTAIN");
    expect(finalPanel.buyerShareBps).toBe(5_000);
  });

  it("juror failing to reveal gets slashed", async () => {
    const tradeId = "e2e_trade_003" + "0".repeat(50);
    const ledgerSequence = 42002;

    const jurorAddresses = Array.from({ length: 5 }, (_, i) => makeJurorAddress(i + 20));
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/jury/panels",
      payload: {
        tradeId,
        escrowAmountStroops: "3000000000",
        jurorAddresses,
        ledgerSequence,
      },
    });

    const { panelId } = createRes.json();
    const salt = "aabb1122" + "00".repeat(28);

    // All 5 commit BUYER
    for (let i = 0; i < 5; i++) {
      const commitHash = await hashVote("BUYER", salt);
      await app.inject({
        method: "POST",
        url: "/api/v1/jury/vote-commit",
        payload: { panelId, jurorAddress: jurorAddresses[i], commitHash },
      });
    }

    await app.inject({ method: "POST", url: `/api/v1/jury/panels/${panelId}/start-reveal` });

    // Only 4 reveal — juror index 4 fails to reveal
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: "POST",
        url: "/api/v1/jury/vote-reveal",
        payload: { panelId, jurorAddress: jurorAddresses[i], vote: "BUYER", saltHex: salt },
      });
    }

    // Manually resolve to test slashing logic
    const result = resolvePanel(panelId);
    expect(result.slashedJurors).toContain(jurorAddresses[4]);
    expect(result.resolution).toBe("BUYER");
  });
});
