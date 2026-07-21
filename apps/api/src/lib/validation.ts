import type { FastifyReply } from 'fastify';
import { z, type ZodTypeAny } from 'zod';

export function parseBody<T extends ZodTypeAny>(schema: T, body: unknown, reply: FastifyReply) {
  const result = schema.safeParse(body);

  if (!result.success) {
    reply.code(400).send({
      error: 'invalid_request',
      details: result.error.flatten(),
    });
    return null;
  }

  return result.data as z.infer<T>;
}
