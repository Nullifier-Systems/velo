import type { FastifyInstance } from 'fastify';

/** GET /api/v1/reputation/:address — on-chain trust signal ($0.0005) */
export async function reputationRoutes(app: FastifyInstance) {
  app.get(
    '/reputation/:address',
    {
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const paid = await (app as any).requirePayment(req, reply, '0.0005');
      if (!paid) return;

      const { address } = req.params as { address: string };
      // TODO: read the soulbound reputation NFT / on-chain trade history.
      return { address, completion_rate: null, trades: null, trusted: null };
    }
  );
}
