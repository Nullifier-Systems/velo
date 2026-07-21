import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { cashRoutes } from './cash.js';
import { servicesRoutes } from './services.js';
import { reputationRoutes } from './reputation.js';

describe('rate limiting', () => {
  /**
   * Helper: creates a minimal Fastify instance for rate-limit testing.
   *
   * When routes have `config.rateLimit`, the per-route config OVERRIDES
   * the global `max`. For tests that exercise per-route limits we build
   * a separate app with explicit per-route limit values.
   */
  async function buildApp(globalMax = 100) {
    const app: any = Fastify();

    await app.register(rateLimit, {
      global: true,
      max: globalMax,
      timeWindow: '1 minute',
    });

    // Minimal requirePayment stub so routes don't abort on payment.
    app.decorate('requirePayment', async (_req: any, _reply: any, _price: string) => {
      return true;
    });

    // A simple route WITHOUT per-route config so it inherits the global limit.
    app.get('/public', async () => ({ ok: true }));

    app.register(servicesRoutes, { prefix: '/api/v1' });
    app.register(cashRoutes, { prefix: '/api/v1' });
    app.register(reputationRoutes, { prefix: '/api/v1' });

    await app.ready();

    return app;
  }

  // ── Global limit tests (route without per-route config) ───────────

  it('enforces the global rate limit on routes without per-route config', async () => {
    const app = await buildApp(2);

    // Consume the 2 allowed requests
    const r1 = await app.inject({ method: 'GET', url: '/public' });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({ method: 'GET', url: '/public' });
    expect(r2.statusCode).toBe(200);

    // 3rd request should be throttled
    const r3 = await app.inject({ method: 'GET', url: '/public' });
    expect(r3.statusCode).toBe(429);

    const body = r3.json();
    expect(body).toHaveProperty('statusCode', 429);
    expect(body).toHaveProperty('error', 'Too Many Requests');
    expect(body.message).toContain('Rate limit exceeded');

    await app.close();
  });

  it('sets retry-after header when globally rate-limited', async () => {
    const app = await buildApp(1);

    // Exhaust the limit
    await app.inject({ method: 'GET', url: '/public' });
    const res = await app.inject({ method: 'GET', url: '/public' });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);

    await app.close();
  });

  // ── Per-route limit tests ────────────────────────────────────────
  //
  // Each route in the production code has its own `config.rateLimit`.
  // Per-route limits override the global max. To test them we build a
  // dedicated app with small per-route values.

  async function buildRouteLimitedApp(max = 3) {
    const app: any = Fastify();

    await app.register(rateLimit, {
      global: true,
      max: 9999, // very high global — we're testing per-route limits
      timeWindow: '1 minute',
    });

    app.decorate('requirePayment', async (_req: any, _reply: any, _price: string) => {
      return true;
    });

    // Routes with per-route limits small enough to exhaust in a test
    app.get(
      '/limited',
      {
        config: { rateLimit: { max, timeWindow: '1 minute' } },
      },
      async () => ({ ok: true })
    );

    app.post(
      '/limited-post',
      {
        config: { rateLimit: { max, timeWindow: '1 minute' } },
      },
      async () => ({ ok: true })
    );

    await app.ready();
    return app;
  }

  it('enforces per-route rate limits', async () => {
    const app = await buildRouteLimitedApp(2);

    await app.inject({ method: 'GET', url: '/limited' });
    await app.inject({ method: 'GET', url: '/limited' });

    const res = await app.inject({ method: 'GET', url: '/limited' });
    expect(res.statusCode).toBe(429);

    await app.close();
  });

  it('enforces per-route limits on POST endpoints', async () => {
    const app = await buildRouteLimitedApp(2);

    await app.inject({ method: 'POST', url: '/limited-post', body: {} });
    await app.inject({ method: 'POST', url: '/limited-post', body: {} });

    const res = await app.inject({ method: 'POST', url: '/limited-post', body: {} });
    expect(res.statusCode).toBe(429);

    await app.close();
  });

  it('allows requests within the per-route limit', async () => {
    const app = await buildRouteLimitedApp(5);

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/limited' });
      expect(res.statusCode).toBe(200);
    }

    await app.close();
  });
});
