import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DISPUTE_JURY } from "@velo/shared";
import {
  createDisputePanel,
  submitVoteCommit,
  submitVoteReveal,
  resolvePanel,
  startRevealPhase,
  allJurorsCommitted,
  panelStore,
  voteCommitStore,
  voteRevealStore,
  type PanelRecord,
} from "../lib/workers/disputeArbitrationWorker.js";
import { parseBody } from "../lib/validation.js";

/* ------------------------------------------------------------------ */
/*  Schemas                                                            */
/* ------------------------------------------------------------------ */

const voteCommitSchema = z.object({
  panelId: z.string().min(1, "panelId is required"),
  jurorAddress: z.string().min(1, "jurorAddress is required"),
  commitHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "commitHash must be 64-char hex"),
});

const voteRevealSchema = z.object({
  panelId: z.string().min(1, "panelId is required"),
  jurorAddress: z.string().min(1, "jurorAddress is required"),
  vote: z.enum(["BUYER", "SELLER", "ABSTAIN"]),
  saltHex: z.string().regex(/^[0-9a-fA-F]{64}$/, "saltHex must be 64-char hex"),
});

const createPanelSchema = z.object({
  tradeId: z.string().min(1),
  escrowAmountStroops: z.string().min(1),
  jurorAddresses: z.array(z.string()).length(DISPUTE_JURY.PANEL_SIZE),
  ledgerSequence: z.number().int().positive(),
});

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

export async function juryArbitrationRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/jury/vote-commit
   * Submit a hashed vote commitment from a VRF-selected panel juror.
   */
  app.post("/jury/vote-commit", async (req, reply) => {
    const body = parseBody(voteCommitSchema, req.body, reply);
    if (!body) return;

    try {
      submitVoteCommit(body.panelId, body.jurorAddress, body.commitHash);

      return reply.code(201).send({
        message: "Vote commitment accepted",
        panelId: body.panelId,
        jurorAddress: body.jurorAddress,
        phase: "COMMIT",
      });
    } catch (err: any) {
      const code =
        err.message === "Panel not found"
          ? "PANEL_NOT_FOUND"
          : err.message === "Panel not in VOTING phase"
            ? "INVALID_PANEL_STATUS"
            : err.message === "Juror not on panel"
              ? "JUROR_NOT_ON_PANEL"
              : err.message === "Juror already committed"
                ? "DUPLICATE_COMMIT"
                : "INTERNAL_ERROR";
      const status =
        code === "PANEL_NOT_FOUND"
          ? 404
          : code === "DUPLICATE_COMMIT"
            ? 409
            : code === "JUROR_NOT_ON_PANEL"
              ? 403
              : 400;
      return reply.code(status).send({ error: err.message, code });
    }
  });

  /**
   * POST /api/v1/jury/vote-reveal
   * Unseal a vote during the REVEAL phase and verify commit-reveal binding.
   */
  app.post("/jury/vote-reveal", async (req, reply) => {
    const body = parseBody(voteRevealSchema, req.body, reply);
    if (!body) return;

    try {
      submitVoteReveal(body.panelId, body.jurorAddress, body.vote, body.saltHex);

      const panel = panelStore.get(body.panelId);
      const reveals = voteRevealStore.get(body.panelId);
      const allRevealed =
        panel &&
        reveals &&
        panel.jurorAddresses.every((addr) => reveals.has(addr));

      let resolution = null;
      if (allRevealed) {
        resolution = resolvePanel(body.panelId);
      }

      return reply.code(201).send({
        message: "Vote reveal accepted",
        panelId: body.panelId,
        jurorAddress: body.jurorAddress,
        phase: "REVEAL",
        allRevealed: allRevealed ?? false,
        resolution: resolution ?? null,
      });
    } catch (err: any) {
      const code =
        err.message === "Panel not found"
          ? "PANEL_NOT_FOUND"
          : err.message === "Panel not in REVEALING phase"
            ? "INVALID_PANEL_STATUS"
            : err.message === "Juror not on panel"
              ? "JUROR_NOT_ON_PANEL"
              : err.message === "Juror already revealed"
                ? "DUPLICATE_REVEAL"
                : "INTERNAL_ERROR";
      const status =
        code === "PANEL_NOT_FOUND"
          ? 404
          : code === "DUPLICATE_REVEAL"
            ? 409
            : code === "JUROR_NOT_ON_PANEL"
              ? 403
              : 400;
      return reply.code(status).send({ error: err.message, code });
    }
  });

  /**
   * POST /api/v1/jury/panels
   * Create a new dispute panel with VRF-selected jurors.
   */
  app.post("/jury/panels", async (req, reply) => {
    const body = parseBody(createPanelSchema, req.body, reply);
    if (!body) return;

    try {
      const panel = createDisputePanel(
        {
          tradeId: body.tradeId,
          escrowAmountStroops: body.escrowAmountStroops,
          buyerAddress: "",
          sellerAddress: "",
        },
        body.jurorAddresses.map((addr) => ({
          jurorAddress: addr,
          stakedAmountStroops: DISPUTE_JURY.MIN_STAKE_STROOPS.toString(),
          reputationScore: 100,
        })),
        body.ledgerSequence,
      );

      return reply.code(201).send({
        panelId: panel.panelId,
        tradeId: panel.tradeId,
        jurorAddresses: panel.jurorAddresses,
        status: panel.status,
        escrowAmountStroops: panel.escrowAmountStroops,
      });
    } catch (err: any) {
      return reply.code(400).send({ error: err.message, code: "PANEL_CREATION_FAILED" });
    }
  });

  /**
   * POST /api/v1/jury/panels/:panelId/start-reveal
   * Transition panel from VOTING to REVEALING phase.
   */
  app.post<{ Params: { panelId: string } }>(
    "/jury/panels/:panelId/start-reveal",
    async (req, reply) => {
      const { panelId } = req.params;
      try {
        if (!allJurorsCommitted(panelId)) {
          return reply.code(400).send({
            error: "Not all jurors have committed yet",
            code: "NOT_ALL_COMMITTED",
          });
        }
        startRevealPhase(panelId);
        return reply.send({ panelId, status: "REVEALING" });
      } catch (err: any) {
        return reply.code(400).send({ error: err.message, code: "PHASE_TRANSITION_FAILED" });
      }
    },
  );

  /**
   * GET /api/v1/jury/panels/:panelId
   * Get panel details and vote status.
   */
  app.get<{ Params: { panelId: string } }>(
    "/jury/panels/:panelId",
    async (req, reply) => {
      try {
        const { panelId } = req.params;
        const panel = panelStore.get(panelId);
        if (!panel) {
          return reply.code(404).send({ error: "Panel not found", code: "PANEL_NOT_FOUND" });
        }

        const commits = voteCommitStore.get(panelId);
        const reveals = voteRevealStore.get(panelId);

        return reply.send({
          panelId: panel.panelId,
          tradeId: panel.tradeId,
          jurorAddresses: panel.jurorAddresses,
          status: panel.status,
          escrowAmountStroops: panel.escrowAmountStroops,
          resolution: panel.resolution,
          buyerShareBps: panel.buyerShareBps,
          createdAt: panel.createdAt,
          resolvedAt: panel.resolvedAt,
          commitsReceived: commits?.size ?? 0,
          revealsReceived: reveals?.size ?? 0,
        });
      } catch (err: any) {
        return reply.code(500).send({ error: err.message, code: "INTERNAL_ERROR" });
      }
    },
  );
}
