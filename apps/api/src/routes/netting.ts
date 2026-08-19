import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db';
import { getH3Index } from '../lib/h3-spatial-index';
import { findCycles } from '../lib/liquidity-netting';
import { redisClient } from '../lib/redis';

export const SpatialClearRequestSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().positive().max(5000),
  maxCycleLength: z.number().int().min(2).max(10).default(5),
});

export default async function (fastify: FastifyInstance) {
  fastify.post('/api/v1/netting/spatial-clear', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = SpatialClearRequestSchema.parse(request.body);
      const h3Index = getH3Index(body.latitude, body.longitude, 8);

      const cycles = await findCycles(h3Index, body.radiusMeters, body.maxCycleLength);
      
      if (!cycles || cycles.length === 0) {
        return reply.status(422).send({
          error: {
            code: 'NO_NETTING_CYCLES_FOUND',
            message: 'No circular liquidity debt paths discovered within specified spatial radius.',
            requestId: (request as any).id || 'req-net-992'
          }
        });
      }

      const cycle = cycles[0];
      const participantIds = cycle.nodes.map(n => n.id).sort(); // Lexicographical sort

      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');

        const paramsStr = participantIds.map((_, i) => `$${i + 1}`).join(', ');
        
        // Ordered Pessimistic Locking
        try {
          await client.query(`
            SELECT id, available_collateral, reserved_collateral 
            FROM provider_accounts 
            WHERE id IN (${paramsStr}) 
            ORDER BY id ASC 
            FOR UPDATE NOWAIT
          `, participantIds);
        } catch (e: any) {
          if (e.code === '55P03' || e.message.includes('could not obtain lock')) {
            await client.query('ROLLBACK');
            return reply.status(409).send({
              error: {
                code: 'NETTING_LOCK_CONTENTION',
                message: `Concurrent liquidity netting operation active in H3 cell ${h3Index}. Try again.`,
                requestId: (request as any).id || 'req-net-991'
              }
            });
          }
          throw e;
        }

        const batchRes = await client.query(`
          INSERT INTO liquidity_netting_batches (h3_index, net_cleared_amount, participant_count, status)
          VALUES ($1, $2, $3, 'LOCKED')
          RETURNING id
        `, [h3Index, cycle.clearedAmount, participantIds.length]);

        const batchId = batchRes.rows[0].id;

        for (const leg of cycle.legs) {
          await client.query(`
            INSERT INTO atomic_swap_legs (swap_id, batch_id, sender_address, receiver_address, amount, hash_lock, timeout_ledger)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [leg.swapId, batchId, leg.sender, leg.receiver, leg.amount, leg.hashLock, leg.timeoutLedger]);
        }

        await client.query('COMMIT');
        
        await redisClient.xadd('velo:netting-execution-queue', '*', 'batchId', batchId, 'payload', JSON.stringify({ batchId, cycle }));
        
        return reply.status(202).send({ batchId, status: 'ACCEPTED', cycle });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({ error: e.errors });
      }
      return reply.status(500).send({ error: 'Internal Server Error' });
    }
  });
}
