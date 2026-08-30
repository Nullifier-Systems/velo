import Fastify from "fastify";
import { describe, expect, it, beforeEach } from "vitest";
import { ApiError } from "../../lib/errors.js";
import { WebhookDeliveryStore } from "../../lib/webhookDeliveryStore.js";
import { webhookRoutes } from "../webhooks.js";

async function buildApp(store: WebhookDeliveryStore, enqueued: unknown[]) {
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send(error.toJSON(request.id as string));
    }
    return reply.send(error);
  });
  await app.register(webhookRoutes, {
    prefix: "/api/v1",
    store,
    enqueue: async (message: unknown) => {
      enqueued.push(message);
    },
  });
  await app.ready();
  return app;
}

describe("webhook endpoints & DLQ replay routes (#445)", () => {
  let store: WebhookDeliveryStore;
  let enqueued: unknown[];

  beforeEach(() => {
    store = new WebhookDeliveryStore();
    enqueued = [];
  });

  it("registers an endpoint and returns a generated secret once", async () => {
    const app = await buildApp(store, enqueued);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/endpoints",
      payload: { user_id: "GALICE", target_url: "https://developer.example.com/hook" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.secret_key).toMatch(/^[0-9a-f]{64}$/);
    expect(body.target_url).toBe("https://developer.example.com/hook");
    expect(body.is_active).toBe(true);
  });

  it("rejects an invalid target_url", async () => {
    const app = await buildApp(store, enqueued);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/endpoints",
      payload: { user_id: "GALICE", target_url: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists only the requesting user's endpoints", async () => {
    const app = await buildApp(store, enqueued);
    await store.registerEndpoint({ userId: "GALICE", targetUrl: "https://a.example.com" });
    await store.registerEndpoint({ userId: "GBOB", targetUrl: "https://b.example.com" });

    const res = await app.inject({ method: "GET", url: "/api/v1/webhooks/endpoints?user_id=GALICE" });
    expect(res.statusCode).toBe(200);
    expect(res.json().endpoints).toHaveLength(1);
    expect(res.json().endpoints[0].target_url).toBe("https://a.example.com");
  });

  it("replays a dead-lettered delivery exactly once", async () => {
    const app = await buildApp(store, enqueued);
    const endpoint = await store.registerEndpoint({ userId: "GALICE", targetUrl: "https://a.example.com" });
    const log = await store.createDeliveryLog({
      endpointId: endpoint.endpointId,
      eventType: "REFUNDED",
      payload: { type: "REFUNDED", data: { trade_id: "t1" } },
      signatureHeader: "sig123",
    });
    await store.recordAttempt(log.deliveryId, { status: "DEAD_LETTER", lastResponseCode: 503 });

    const firstReplay = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/dlq/replay",
      payload: { delivery_id: log.deliveryId },
    });
    expect(firstReplay.statusCode).toBe(202);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      deliveryId: log.deliveryId,
      targetUrl: "https://a.example.com",
      signature: "sig123",
    });

    // Already QUEUED now — a second replay must be refused, not re-enqueue.
    const secondReplay = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/dlq/replay",
      payload: { delivery_id: log.deliveryId },
    });
    expect(secondReplay.statusCode).toBe(409);
    expect(enqueued).toHaveLength(1);
  });

  it("404s replaying a delivery that does not exist", async () => {
    const app = await buildApp(store, enqueued);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/dlq/replay",
      payload: { delivery_id: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(409);
  });
});
