import { createClient } from 'redis';

export const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

redisClient.on('error', (err: any) => console.error('Redis Client Error', err));

if (!redisClient.isOpen) {
  redisClient.connect().catch(() => {});
}
