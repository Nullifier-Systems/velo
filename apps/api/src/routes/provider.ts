import type { FastifyInstance } from 'fastify';
import { getProviderTrades } from '../lib/store.js';

/**
 * GET /api/v1/provider/dashboard — authenticated earnings dashboard
 */
export async function providerRoutes(app: FastifyInstance) {
  app.get('/provider/dashboard', async (req, reply) => {
    // Authentication: For MVP, we trust the x-provider-address header.
    // TODO: Verify SEP-10 or ed25519 signature to strictly ensure this is the provider's own address.
    const providerAddress = req.headers['x-provider-address'];

    if (!providerAddress || typeof providerAddress !== 'string') {
      reply.code(401).send({ error: 'Unauthorized: Missing x-provider-address header' });
      return;
    }

    const allTrades = getProviderTrades(providerAddress);

    // Calculate total volume from released/completed trades
    const completedTrades = allTrades.filter((t) => t.status === 'released');

    let totalStroops = 0n;
    for (const trade of completedTrades) {
      totalStroops += BigInt(trade.amountStroops);
    }

    // For MVP, assume a fixed 1% fee earned by the provider
    const totalVolume = Number(totalStroops) / 10000000;
    const feesEarned = totalVolume * 0.01;

    return {
      address: providerAddress,
      metrics: {
        total_trades: completedTrades.length,
        total_volume_usdc: totalVolume.toFixed(2),
        fees_earned_usdc: feesEarned.toFixed(2),
      },
      trades: allTrades
        .map((t) => ({
          id: t.id,
          buyer: t.buyer,
          amount_stroops: t.amountStroops,
          status: t.status,
          created_at: t.createdAt,
        }))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    };
  });

  app.get('/provider/export', async (req, reply) => {
    const providerAddress = req.headers['x-provider-address'];

    if (!providerAddress || typeof providerAddress !== 'string') {
      reply.code(401).send({ error: 'Unauthorized: Missing x-provider-address header' });
      return;
    }

    const allTrades = getProviderTrades(providerAddress);
    const completedTrades = allTrades.filter((t) => t.status === 'released');
    const format = (req.query as any).format;

    if (format === 'csv') {
      const headers = [
        'Trade ID',
        'Buyer Address',
        'Amount (Stroops)',
        'Amount (USDC)',
        'Status',
        'Created At',
      ];
      const csvContent = [
        headers.join(','),
        ...completedTrades.map((t) =>
          [
            t.id,
            t.buyer,
            t.amountStroops,
            (Number(t.amountStroops) / 10000000).toFixed(2),
            t.status,
            t.createdAt,
          ]
            .map((val) => `"${String(val).replace(/"/g, '""')}"`)
            .join(','),
        ),
      ].join('\n');

      reply
        .header('Content-Type', 'text/csv')
        .header(
          'Content-Disposition',
          `attachment; filename="completed_trades_${providerAddress.substring(0, 8)}.csv"`,
        )
        .send(csvContent);
      return;
    }

    // Default or explicit JSON format
    const jsonOutput = completedTrades.map((t) => ({
      id: t.id,
      buyer: t.buyer,
      amount_stroops: t.amountStroops,
      amount_usdc: (Number(t.amountStroops) / 10000000).toFixed(2),
      status: t.status,
      created_at: t.createdAt,
    }));

    reply
      .header('Content-Type', 'application/json')
      .header(
        'Content-Disposition',
        `attachment; filename="completed_trades_${providerAddress.substring(0, 8)}.json"`,
      )
      .send(jsonOutput);
  });
}
