import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import {
  webhooksRoutes,
  inMemoryWebhookStore,
} from "../webhooks.js";
import {
  generateWebhookSignature,
  verifyWebhookSignature,
  generateWebhookSecret,
  validateWebhookUrl,
  enqueueWebhookDelivery,
  dispatchWebhookEvent,
} from "../../lib/webhook.js";
import {
  startWebhookDeliveryWorker,
  type WebhookQueueClient,
} from "../../lib/workers/webhookDeliveryWorker.js";
import {
  WEBHOOK_DELIVERY,
  type WebhookDeliveryMessage,
} from "@velo/shared";
import { WebhookStore } from "../../lib/webhook-store.js";

describe("Distributed Webhook Event Delivery Engine & DLQ Recovery (Issue #445)", () => {
  let app: ReturnType<typeof Fastify>;
  let store: WebhookStore;

  beforeEach(async () => {
    store = new WebhookStore();
    inMemoryWebhookStore.clearMemory();
    app = Fastify();
    await app.register(webhooksRoutes, { prefix: "/api/v1", store });
    await app.ready();
  });

  describe("HMAC-SHA256 Signature & Secret Key Cryptography", () => {
    it("generates deterministic HMAC-SHA256 signature against payload", () => {
      const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const payload = { tradeId: "trade-123", amount: "50000000", status: "REFUNDED" };

      const sig1 = generateWebhookSignature(payload, secret);
      const sig2 = generateWebhookSignature(payload, secret);

      expect(sig1).toHaveLength(64);
      expect(sig1).toBe(sig2);
      expect(verifyWebhookSignature(payload, secret, sig1)).toBe(true);
    });

    it("verifies string and object payloads consistently", () => {
      const secret = "test-secret-key-12345";
      const payloadObj = { event: "ping", nonce: 42 };
      const payloadStr = JSON.stringify(payloadObj);

      const sigObj = generateWebhookSignature(payloadObj, secret);
      const sigStr = generateWebhookSignature(payloadStr, secret);

      expect(sigObj).toBe(sigStr);
      expect(verifyWebhookSignature(payloadStr, secret, sigObj)).toBe(true);
    });

    it("rejects tampered payloads and invalid signatures", () => {
      const secret = "valid-secret-key-67890";
      const authenticPayload = { tradeId: "trade-original", amount: "100" };
      const tamperedPayload = { tradeId: "trade-original", amount: "999999" };

      const validSig = generateWebhookSignature(authenticPayload, secret);

      expect(verifyWebhookSignature(tamperedPayload, secret, validSig)).toBe(false);
      expect(verifyWebhookSignature(authenticPayload, "wrong-secret", validSig)).toBe(false);
      expect(verifyWebhookSignature(authenticPayload, secret, "invalid-hex-signature")).toBe(false);
      expect(verifyWebhookSignature(authenticPayload, secret, "")).toBe(false);
    });

    it("generates 32-byte (64 hex chars) random secret keys", () => {
      const secret1 = generateWebhookSecret();
      const secret2 = generateWebhookSecret();

      expect(secret1).toHaveLength(64);
      expect(secret2).toHaveLength(64);
      expect(secret1).not.toBe(secret2);
      expect(/^[0-9a-f]{64}$/.test(secret1)).toBe(true);
    });

    it("validates target URLs and enforces HTTPS in production", () => {
      expect(validateWebhookUrl("https://example.com/webhook", false)).toBe(true);
      expect(validateWebhookUrl("http://localhost:4000/webhook", false)).toBe(true);
      expect(validateWebhookUrl("not-a-url", false)).toBe(false);

      // In production mode (enforceHttps = true)
      expect(validateWebhookUrl("https://api.example.com/events", true)).toBe(true);
      expect(validateWebhookUrl("http://insecure.example.com/events", true)).toBe(false);
    });
  });

  describe("API Routes: Endpoint Management & Logs", () => {
    it("registers a new webhook endpoint with auto-generated 32-byte secret key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/endpoints",
        payload: {
          user_id: "usr_merchant_001",
          target_url: "https://merchant.example.com/velo-hook",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.user_id).toBe("usr_merchant_001");
      expect(body.target_url).toBe("https://merchant.example.com/velo-hook");
      expect(body.secret_key).toHaveLength(64);
      expect(body.is_active).toBe(true);
      expect(body.endpoint_id).toBeDefined();
    });

    it("accepts custom secret keys on registration", async () => {
      const customSecret = "custom_secret_key_12345678901234567890123456789012";
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/endpoints",
        payload: {
          user_id: "usr_custom_002",
          target_url: "https://custom.example.com/webhook",
          secret_key: customSecret,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.secret_key).toBe(customSecret);
    });

    it("rejects endpoint registration with missing parameters", async () => {
      const res1 = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/endpoints",
        payload: { target_url: "https://example.com/hook" },
      });
      expect(res1.statusCode).toBe(400);
      expect(res1.json().code).toBe("INVALID_USER_ID");

      const res2 = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/endpoints",
        payload: { user_id: "usr_test" },
      });
      expect(res2.statusCode).toBe(400);
      expect(res2.json().code).toBe("INVALID_TARGET_URL");

      const res3 = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/endpoints",
        payload: { user_id: "usr_test", target_url: "invalid-url-string" },
      });
      expect(res3.statusCode).toBe(400);
      expect(res3.json().code).toBe("INVALID_TARGET_URL");
    });

    it("lists registered endpoints filtered by user_id", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/endpoints",
        payload: { user_id: "user_a", target_url: "https://a.com/hook" },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/endpoints",
        payload: { user_id: "user_b", target_url: "https://b.com/hook" },
      });

      const resAll = await app.inject({
        method: "GET",
        url: "/api/v1/webhooks/endpoints",
      });
      expect(resAll.statusCode).toBe(200);
      expect(resAll.json().endpoints).toHaveLength(2);

      const resUserA = await app.inject({
        method: "GET",
        url: "/api/v1/webhooks/endpoints?user_id=user_a",
      });
      expect(resUserA.statusCode).toBe(200);
      expect(resUserA.json().endpoints).toHaveLength(1);
      expect(resUserA.json().endpoints[0].user_id).toBe("user_a");
    });

    it("lists delivery logs with status and filter support", async () => {
      const ep = await store.createEndpoint({
        userId: "user_log_test",
        targetUrl: "https://logtest.example.com",
      });

      await store.createDeliveryLog({
        endpointId: ep.endpointId,
        eventType: "trade.refunded",
        payload: { tradeId: "t-1" },
        signatureHeader: "sig1",
        status: "DELIVERED",
        attemptCount: 1,
        lastResponseCode: 200,
      });

      await store.createDeliveryLog({
        endpointId: ep.endpointId,
        eventType: "trade.refunded",
        payload: { tradeId: "t-2" },
        signatureHeader: "sig2",
        status: "DEAD_LETTER",
        attemptCount: 5,
        lastResponseCode: 500,
      });

      const resAll = await app.inject({
        method: "GET",
        url: "/api/v1/webhooks/logs",
      });
      expect(resAll.statusCode).toBe(200);
      expect(resAll.json().logs).toHaveLength(2);

      const resDlq = await app.inject({
        method: "GET",
        url: "/api/v1/webhooks/logs?status=DEAD_LETTER",
      });
      expect(resDlq.statusCode).toBe(200);
      expect(resDlq.json().logs).toHaveLength(1);
      expect(resDlq.json().logs[0].status).toBe("DEAD_LETTER");
    });
  });

  describe("Delivery Worker, Exponential Backoff & DLQ Simulation", () => {
    it("delivers webhook successfully on 200 response with valid HMAC header", async () => {
      const ep = await store.createEndpoint({
        userId: "user_delivery_success",
        targetUrl: "https://webhook-receiver.example.com/payouts",
      });

      const payload = { tradeId: "trade-xyz", refundAmount: "10000000" };
      const expectedSig = generateWebhookSignature(payload, ep.secretKey);

      let receivedHeaders: Record<string, string> = {};
      let receivedBody = "";

      const mockFetch = vi.fn().mockImplementation(async (url, init) => {
        receivedHeaders = init.headers;
        receivedBody = init.body;
        return {
          ok: true,
          status: 200,
          text: async () => "OK",
        };
      });

      const queue: WebhookDeliveryMessage[] = [];
      const dlq: WebhookDeliveryMessage[] = [];
      const events: any[] = [];

      const log = await enqueueWebhookDelivery({
        store,
        endpoint: ep,
        eventType: "trade.refunded",
        payload,
      });

      queue.push({
        deliveryId: log.deliveryId,
        endpointId: ep.endpointId,
        targetUrl: ep.targetUrl,
        secretKey: ep.secretKey,
        eventType: "trade.refunded",
        payload: JSON.stringify(payload),
        signatureHeader: log.signatureHeader,
      });

      const stopWorker = startWebhookDeliveryWorker({
        store,
        queue,
        dlq,
        pollIntervalMs: 10,
        baseDelayMs: 5,
        fetchFn: mockFetch as any,
        onEvent: (e) => events.push(e),
      });

      // Allow worker tick to run
      await new Promise((r) => setTimeout(r, 50));
      stopWorker();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(receivedHeaders["x-velo-signature"]).toBe(expectedSig);
      expect(receivedHeaders["x-velo-event"]).toBe("trade.refunded");
      expect(receivedHeaders["x-velo-delivery-id"]).toBe(log.deliveryId);
      expect(JSON.parse(receivedBody)).toEqual(payload);

      const updatedLog = await store.getDeliveryLog(log.deliveryId);
      expect(updatedLog?.status).toBe("DELIVERED");
      expect(updatedLog?.attemptCount).toBe(1);
      expect(updatedLog?.lastResponseCode).toBe(200);

      expect(events).toEqual([
        {
          type: "delivered",
          deliveryId: log.deliveryId,
          attempts: 1,
          statusCode: 200,
        },
      ]);
    });

    it("retries 5 consecutive HTTP 500 failures with backoff and moves to DEAD_LETTER", async () => {
      const ep = await store.createEndpoint({
        userId: "user_fail_test",
        targetUrl: "https://failing-receiver.example.com/webhooks",
      });

      const payload = { tradeId: "trade-fail", amount: "50000000" };

      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        };
      });

      const queue: WebhookDeliveryMessage[] = [];
      const dlq: WebhookDeliveryMessage[] = [];
      const events: any[] = [];

      const log = await enqueueWebhookDelivery({
        store,
        endpoint: ep,
        eventType: "trade.refunded",
        payload,
      });

      queue.push({
        deliveryId: log.deliveryId,
        endpointId: ep.endpointId,
        targetUrl: ep.targetUrl,
        secretKey: ep.secretKey,
        eventType: "trade.refunded",
        payload: JSON.stringify(payload),
        signatureHeader: log.signatureHeader,
      });

      const stopWorker = startWebhookDeliveryWorker({
        store,
        queue,
        dlq,
        pollIntervalMs: 10,
        baseDelayMs: 2, // fast delay for unit test
        maxAttempts: 5,
        fetchFn: mockFetch as any,
        onEvent: (e) => events.push(e),
      });

      // Wait for all 5 retry attempts to complete
      await new Promise((r) => setTimeout(r, 200));
      stopWorker();

      expect(mockFetch).toHaveBeenCalledTimes(5);

      const updatedLog = await store.getDeliveryLog(log.deliveryId);
      expect(updatedLog?.status).toBe("DEAD_LETTER");
      expect(updatedLog?.attemptCount).toBe(5);
      expect(updatedLog?.lastResponseCode).toBe(500);

      expect(dlq).toHaveLength(1);
      expect(dlq[0].deliveryId).toBe(log.deliveryId);

      const retryEvents = events.filter((e) => e.type === "retry");
      expect(retryEvents).toHaveLength(5);

      const dlqEvents = events.filter((e) => e.type === "dead-letter");
      expect(dlqEvents).toHaveLength(1);
      expect(dlqEvents[0].deliveryId).toBe(log.deliveryId);
      expect(dlqEvents[0].statusCode).toBe(500);
    });

    it("processes Redis Streams with xReadGroup and xAck", async () => {
      const ep = await store.createEndpoint({
        userId: "user_redis_test",
        targetUrl: "https://redis-test.example.com",
      });

      const log = await store.createDeliveryLog({
        endpointId: ep.endpointId,
        eventType: "trade.refunded",
        payload: { tradeId: "redis-trade-1" },
        signatureHeader: "sig-redis",
        status: "QUEUED",
      });

      const mockRedis: WebhookQueueClient = {
        xGroupCreate: vi.fn().mockResolvedValue("OK"),
        xReadGroup: vi.fn().mockResolvedValueOnce([
          {
            name: WEBHOOK_DELIVERY.QUEUE,
            messages: [
              {
                id: "1600000000000-0",
                message: {
                  deliveryId: log.deliveryId,
                  endpointId: ep.endpointId,
                  targetUrl: ep.targetUrl,
                  secretKey: ep.secretKey,
                  eventType: "trade.refunded",
                  payload: JSON.stringify({ tradeId: "redis-trade-1" }),
                  signatureHeader: "sig-redis",
                },
              },
            ],
          },
        ]).mockResolvedValue([]),
        xAck: vi.fn().mockResolvedValue(1),
        xAdd: vi.fn().mockResolvedValue("1600000000001-0"),
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "OK",
      });

      const stopWorker = startWebhookDeliveryWorker({
        store,
        redis: mockRedis,
        pollIntervalMs: 10,
        baseDelayMs: 2,
        fetchFn: mockFetch as any,
      });

      await new Promise((r) => setTimeout(r, 60));
      stopWorker();

      expect(mockRedis.xGroupCreate).toHaveBeenCalledWith(
        WEBHOOK_DELIVERY.QUEUE,
        WEBHOOK_DELIVERY.GROUP,
        "0",
        { MKSTREAM: true },
      );
      expect(mockRedis.xAck).toHaveBeenCalledWith(
        WEBHOOK_DELIVERY.QUEUE,
        WEBHOOK_DELIVERY.GROUP,
        "1600000000000-0",
      );

      const deliveredLog = await store.getDeliveryLog(log.deliveryId);
      expect(deliveredLog?.status).toBe("DELIVERED");
    });
  });

  describe("Dead-Letter Queue (DLQ) Manual Replay", () => {
    it("replays dead-letter deliveries, resets status to QUEUED and attempt_count to 0", async () => {
      const ep = await store.createEndpoint({
        userId: "user_dlq_replay",
        targetUrl: "https://dlq-replay.example.com",
      });

      const log1 = await store.createDeliveryLog({
        endpointId: ep.endpointId,
        eventType: "trade.refunded",
        payload: { tradeId: "t-dlq-1" },
        signatureHeader: "sig1",
        status: "DEAD_LETTER",
        attemptCount: 5,
        lastResponseCode: 500,
      });

      const log2 = await store.createDeliveryLog({
        endpointId: ep.endpointId,
        eventType: "trade.refunded",
        payload: { tradeId: "t-dlq-2" },
        signatureHeader: "sig2",
        status: "DELIVERED",
        attemptCount: 1,
        lastResponseCode: 200,
      });

      const inMemQueue: WebhookDeliveryMessage[] = [];
      const replayApp = Fastify();
      await replayApp.register(webhooksRoutes, {
        prefix: "/api/v1",
        store,
        queue: inMemQueue,
      });
      await replayApp.ready();

      const res = await replayApp.inject({
        method: "POST",
        url: "/api/v1/webhooks/dlq/replay",
        payload: { delivery_ids: [log1.deliveryId] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.replayed).toBe(1);
      expect(body.delivery_ids).toContain(log1.deliveryId);

      const updatedLog1 = await store.getDeliveryLog(log1.deliveryId);
      expect(updatedLog1?.status).toBe("QUEUED");
      expect(updatedLog1?.attemptCount).toBe(0);
      expect(updatedLog1?.lastResponseCode).toBeNull();

      // Delivered log should remain unchanged
      const updatedLog2 = await store.getDeliveryLog(log2.deliveryId);
      expect(updatedLog2?.status).toBe("DELIVERED");
      expect(updatedLog2?.attemptCount).toBe(1);

      // Replayed message is re-enqueued
      expect(inMemQueue).toHaveLength(1);
      expect(inMemQueue[0].deliveryId).toBe(log1.deliveryId);
    });

    it("replays all DLQ deliveries when all: true is passed", async () => {
      const ep = await store.createEndpoint({
        userId: "user_bulk_dlq",
        targetUrl: "https://bulk-dlq.example.com",
      });

      const log1 = await store.createDeliveryLog({
        endpointId: ep.endpointId,
        eventType: "trade.refunded",
        payload: { tradeId: "t-bulk-1" },
        signatureHeader: "sig1",
        status: "DEAD_LETTER",
        attemptCount: 5,
      });

      const log2 = await store.createDeliveryLog({
        endpointId: ep.endpointId,
        eventType: "trade.refunded",
        payload: { tradeId: "t-bulk-2" },
        signatureHeader: "sig2",
        status: "DEAD_LETTER",
        attemptCount: 5,
      });

      const inMemQueue: WebhookDeliveryMessage[] = [];
      const replayApp = Fastify();
      await replayApp.register(webhooksRoutes, {
        prefix: "/api/v1",
        store,
        queue: inMemQueue,
      });
      await replayApp.ready();

      const res = await replayApp.inject({
        method: "POST",
        url: "/api/v1/webhooks/dlq/replay",
        payload: { all: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().replayed).toBe(2);

      expect(inMemQueue).toHaveLength(2);
    });
  });

  describe("Multi-Node Event Dispatching", () => {
    it("dispatches events across multiple registered endpoints for a user", async () => {
      const ep1 = await store.createEndpoint({
        userId: "multi_node_user",
        targetUrl: "https://node1.example.com/events",
      });
      const ep2 = await store.createEndpoint({
        userId: "multi_node_user",
        targetUrl: "https://node2.example.com/events",
      });

      const logs = await dispatchWebhookEvent({
        store,
        userId: "multi_node_user",
        eventType: "trade.refunded",
        payload: { tradeId: "trade-multi-node", amountUsdc: "100.00" },
      });

      expect(logs).toHaveLength(2);
      expect(logs.map((l) => l.endpointId)).toContain(ep1.endpointId);
      expect(logs.map((l) => l.endpointId)).toContain(ep2.endpointId);
      expect(logs.every((l) => l.status === "QUEUED")).toBe(true);
    });
  });
});
