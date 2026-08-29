/**
 * Webhook Routes (Issue #445)
 *
 * Exposes endpoints for:
 * - Registering developer webhook endpoints (with 32-byte HMAC secret key generation)
 * - Listing registered endpoints and delivery logs
 * - Replaying failed Dead-Letter Queue (DLQ) deliveries with row-level locks (SELECT FOR UPDATE)
 */
import type { FastifyPluginAsync } from "fastify";
import {
  WEBHOOK_DELIVERY,
  type WebhookDeliveryLog,
  type WebhookDeliveryMessage,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
} from "@velo/shared";
import { WebhookStore } from "../lib/webhook-store.js";
import { validateWebhookUrl } from "../lib/webhook.js";
import type { WebhookQueueClient } from "../lib/workers/webhookDeliveryWorker.js";

export interface WebhooksPluginOptions {
  store?: WebhookStore;
  redis?: WebhookQueueClient;
  queue?: WebhookDeliveryMessage[];
}

export const inMemoryWebhookStore = new WebhookStore();

export const webhooksRoutes: FastifyPluginAsync<WebhooksPluginOptions> = async (
  app,
  opts,
) => {
  const store =
    opts.store ??
    (app as any).webhookStore ??
    ((app as any).pg ? new WebhookStore((app as any).pg) : inMemoryWebhookStore);
  const redis = opts.redis ?? (app as any).redis;
  const inMemQueue = opts.queue;

  /**
   * POST /webhooks/endpoints
   * Register a new webhook target URL for a user/developer.
   */
  app.post<{
    Body: {
      user_id?: string;
      userId?: string;
      target_url?: string;
      targetUrl?: string;
      secret_key?: string;
      secretKey?: string;
    };
  }>(
    "/webhooks/endpoints",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const userId = (req.body?.user_id || req.body?.userId || "").trim();
      const targetUrl = (req.body?.target_url || req.body?.targetUrl || "").trim();
      const secretKey = (req.body?.secret_key || req.body?.secretKey || "").trim() || undefined;

      if (!userId) {
        return reply.status(400).send({
          error: "Missing required parameter: user_id",
          code: "INVALID_USER_ID",
        });
      }

      if (!targetUrl) {
        return reply.status(400).send({
          error: "Missing required parameter: target_url",
          code: "INVALID_TARGET_URL",
        });
      }

      if (!validateWebhookUrl(targetUrl)) {
        const isProd = process.env.NODE_ENV === "production";
        return reply.status(400).send({
          error: isProd
            ? "Invalid target_url: HTTPS protocol is strictly enforced in production"
            : "Invalid target_url format",
          code: "INVALID_TARGET_URL",
        });
      }

      const endpoint = await store.createEndpoint({
        userId,
        targetUrl,
        secretKey,
      });

      return reply.status(201).send({
        endpoint_id: endpoint.endpointId,
        endpointId: endpoint.endpointId,
        user_id: endpoint.userId,
        userId: endpoint.userId,
        target_url: endpoint.targetUrl,
        targetUrl: endpoint.targetUrl,
        secret_key: endpoint.secretKey,
        secretKey: endpoint.secretKey,
        is_active: endpoint.isActive,
        isActive: endpoint.isActive,
        created_at: endpoint.createdAt,
        createdAt: endpoint.createdAt,
      });
    },
  );

  /**
   * GET /webhooks/endpoints
   * List registered endpoints, optionally filtered by user_id.
   */
  app.get<{
    Querystring: {
      user_id?: string;
      userId?: string;
    };
  }>(
    "/webhooks/endpoints",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const userId = req.query.user_id || req.query.userId;
      const endpoints = await store.listEndpoints(userId);

      return reply.status(200).send({
        endpoints: endpoints.map((e: WebhookEndpoint) => ({
          endpoint_id: e.endpointId,
          endpointId: e.endpointId,
          user_id: e.userId,
          userId: e.userId,
          target_url: e.targetUrl,
          targetUrl: e.targetUrl,
          secret_key: e.secretKey,
          secretKey: e.secretKey,
          is_active: e.isActive,
          isActive: e.isActive,
          created_at: e.createdAt,
          createdAt: e.createdAt,
        })),
      });
    },
  );

  /**
   * GET /webhooks/logs
   * List delivery logs with optional filtering by endpoint, user, or status.
   */
  app.get<{
    Querystring: {
      endpoint_id?: string;
      endpointId?: string;
      user_id?: string;
      userId?: string;
      status?: WebhookDeliveryStatus;
      limit?: string;
    };
  }>(
    "/webhooks/logs",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const endpointId = req.query.endpoint_id || req.query.endpointId;
      const userId = req.query.user_id || req.query.userId;
      const status = req.query.status;
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;

      const logs = await store.listDeliveryLogs({
        endpointId,
        userId,
        status,
        limit,
      });

      return reply.status(200).send({
        logs: logs.map((l: WebhookDeliveryLog) => ({
          delivery_id: l.deliveryId,
          deliveryId: l.deliveryId,
          endpoint_id: l.endpointId,
          endpointId: l.endpointId,
          event_type: l.eventType,
          eventType: l.eventType,
          payload: l.payload,
          signature_header: l.signatureHeader,
          signatureHeader: l.signatureHeader,
          attempt_count: l.attemptCount,
          attemptCount: l.attemptCount,
          status: l.status,
          last_response_code: l.lastResponseCode,
          lastResponseCode: l.lastResponseCode,
          created_at: l.createdAt,
          createdAt: l.createdAt,
        })),
      });
    },
  );

  /**
   * POST /webhooks/dlq/replay
   * Re-enqueues failed dead-letter deliveries using SELECT FOR UPDATE lock.
   */
  app.post<{
    Body: {
      delivery_ids?: string[];
      deliveryIds?: string[];
      delivery_id?: string;
      deliveryId?: string;
      endpoint_id?: string;
      endpointId?: string;
      all?: boolean;
    };
  }>(
    "/webhooks/dlq/replay",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      let deliveryIds = req.body?.delivery_ids || req.body?.deliveryIds;
      const singleId = req.body?.delivery_id || req.body?.deliveryId;
      if (singleId) {
        deliveryIds = deliveryIds ? [...deliveryIds, singleId] : [singleId];
      }
      const endpointId = req.body?.endpoint_id || req.body?.endpointId;
      const all = req.body?.all ?? (Boolean(!deliveryIds && !endpointId));

      const result = await store.replayDlqDeliveries({
        deliveryIds,
        endpointId,
        all,
      });

      // Re-enqueue replayed messages to Redis Stream or in-memory queue
      for (const log of result.logs) {
        const endpoint = await store.getEndpoint(log.endpointId);
        if (!endpoint) continue;

        if (redis) {
          await redis
            .xAdd(WEBHOOK_DELIVERY.QUEUE, "*", {
              deliveryId: log.deliveryId,
              endpointId: log.endpointId,
              targetUrl: endpoint.targetUrl,
              secretKey: endpoint.secretKey,
              eventType: log.eventType,
              payload: JSON.stringify(log.payload),
              signatureHeader: log.signatureHeader,
            })
            .catch((err: unknown) =>
              req.log.error(err, "Failed to re-enqueue replayed DLQ event"),
            );
        } else if (inMemQueue) {
          inMemQueue.push({
            deliveryId: log.deliveryId,
            endpointId: log.endpointId,
            targetUrl: endpoint.targetUrl,
            secretKey: endpoint.secretKey,
            eventType: log.eventType,
            payload: JSON.stringify(log.payload),
            signatureHeader: log.signatureHeader,
            attemptCount: 0,
          });
        }
      }


      return reply.status(200).send({
        replayed: result.replayed,
        delivery_ids: result.deliveryIds,
        deliveryIds: result.deliveryIds,
        message: `Successfully replayed ${result.replayed} dead-letter delivery(ies)`,
      });
    },
  );
};
