import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  SwapDisputeStore,
} from "../lib/workers/swapDisputeWorker.js";

const RegisterDisputeSchema = z.object({
  swapId: z.string().min(1).max(64),
  initiatorAddress: z.string().min(1),
  counterpartyAddress: z.string().min(1),
  secretHash: z.string().min(32),
  expirationLedger: z.number().int().positive(),
});

const ExtractSecretSchema = z.object({
  swapId: z.string().min(1).max(64),
  secretPreimage: z.string().min(32),
  chain: z.string().min(1),
  blockOrLedger: z.number().int().positive().optional(),
});

const DisputeClaimSchema = z.object({
  swapId: z.string().min(1).max(64),
  currentLedger: z.number().int().positive(),
});

export interface SwapDisputeRouteOptions {
  store?: SwapDisputeStore;
}

export const swapDisputeRoutes: FastifyPluginAsync<SwapDisputeRouteOptions> = async (
  fastify,
  opts,
) => {
  const store = opts.store ?? new SwapDisputeStore();

  fastify.post("/swaps/register-dispute", async (req, reply) => {
    const parseRes = RegisterDisputeSchema.safeParse(req.body);
    if (!parseRes.success) {
      return reply.status(400).send({ error: parseRes.error.format() });
    }
    const record = await store.registerBridge(parseRes.data);
    return reply.status(201).send(record);
  });

  fastify.post("/swaps/extract-secret", async (req, reply) => {
    const parseRes = ExtractSecretSchema.safeParse(req.body);
    if (!parseRes.success) {
      return reply.status(400).send({ error: parseRes.error.format() });
    }
    const { swapId, secretPreimage, chain, blockOrLedger } = parseRes.data;
    try {
      const outcome = await store.extractSecretPreimage(
        swapId,
        secretPreimage,
        chain,
        blockOrLedger,
      );
      return reply.status(200).send({
        swapId,
        secretPreimage,
        chain,
        ...outcome,
      });
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.post("/swaps/dispute-claim", async (req, reply) => {
    const parseRes = DisputeClaimSchema.safeParse(req.body);
    if (!parseRes.success) {
      return reply.status(400).send({ error: parseRes.error.format() });
    }
    const { swapId, currentLedger } = parseRes.data;
    try {
      const result = await store.claimDisputeRefundOrResolve(
        swapId,
        currentLedger,
      );
      return reply.status(200).send(result);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get<{ Params: { swapId: string } }>(
    "/swaps/dispute/:swapId",
    async (req, reply) => {
      const { swapId } = req.params;
      const bridge = await store.getBridge(swapId);
      if (!bridge) {
        return reply.status(404).send({ error: "Dispute bridge swap not found" });
      }
      return reply.status(200).send(bridge);
    },
  );
};
