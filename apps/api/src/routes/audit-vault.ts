import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { ProofGenerator } from "../lib/audit/proof-generator.js";

export const auditVaultRoutes: FastifyPluginAsync = async (
    fastify: FastifyInstance
) => {
    // Only available if DB is configured
    if (!fastify.hasDecorator("pg")) {
        return;
    }

    const pool = (fastify as any).pg;
    const proofGenerator = new ProofGenerator(pool);

    fastify.get<{
        Params: { eventId: string }
    }>("/audit/proof/:eventId", {
        config: {
            rateLimit: { max: 30, timeWindow: "1 minute" }
        }
    }, async (request, reply) => {
        try {
            const proof = await proofGenerator.generateProof(request.params.eventId);
            return proof;
        } catch (err: any) {
            request.log.error(err, "Failed to generate audit proof");
            if (err.message.includes("Audit root not yet anchored") || err.message.includes("not found")) {
                return reply.status(404).send({ error: err.message });
            }
            return reply.status(500).send({ error: "Internal server error" });
        }
    });
};
