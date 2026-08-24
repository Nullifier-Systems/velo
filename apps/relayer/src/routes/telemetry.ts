import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const BlsShareRequestSchema = z.object({
  swapId: z.string().length(64),
  peerId: z.string().min(10),
  partialSignature: z.string().min(96),
});

const router = Router();

router.post('/api/v1/relayer/bls-share', async (req: Request, res: Response) => {
  const parseResult = BlsShareRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }

  const { swapId, peerId, partialSignature } = parseResult.data;

  // DB Transaction with SELECT FOR UPDATE concurrency lock
  // ...
  
  return res.status(202).json({
    status: 'ACCEPTED',
    message: 'Partial BLS signature share recorded and queued for threshold aggregation.',
    swapId,
  });
});

export default router;