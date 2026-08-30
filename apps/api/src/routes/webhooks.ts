/**
 * Distributed Multi-Node Webhook Event Delivery Engine & DLQ Recovery (#445).
 *
 * POST /webhooks/endpoints            — register a target URL; returns the
 *                                        generated HMAC secret once.
 * GET  /webhooks/endpoints            — list a developer's registered
 *                                        endpoints (?user_id=...).
 * GET  /webhooks/endpoints/:id/deliveries — recent delivery attempts for one
 *                                        endpoint, for the developer portal.
 * POST /webhooks/dlq/replay           — re-enqueue a dead-lettered delivery.
 *
 * Actual HTTP delivery never happens on this thread — every accepted event
 * (see webhook.ts's `notifyDeveloperWebhooks`, called from cash.ts) is
 * enqueued onto `velo:webhook-delivery-queue` for `webhookDeliveryWorker` to
 * send, so a slow or dead client endpoint can never block an API response.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createClient, type RedisClientType } from "redis";
import { WEBHOOK_DELIVERY_QUEUE } from "@velo/shared";
import { parseBody } from "../lib/validation.js";
import { ApiError, ErrorCode } from "../lib/errors.js";
import { WebhookDeliveryStore } from "../lib/webhookDeliveryStore.js";

const registerEndpointSchema = z.object({
  user_id: z.string().min(1).max(64),
  target_url: z.string().url("target_url must be a valid URL"),
});

const dlqReplaySchema = z.object({
  delivery_id: z.string().min(1),
});

export interface WebhookRoutesOptions {
  store?: WebhookDeliveryStore;
  /** Overridable in tests — hands a replayed delivery to the worker. */
  enqueue?: (message: {
    deliveryId: string;
    endpointId: string;
    targetUrl: string;
    payload: string;
    signature: string;
  }) => Promise<void>;
}

let queueClient: RedisClientType | undefined;

async function enqueueToRedis(message: {
  deliveryId: string;
  endpointId: string;
  targetUrl: string;
  payload: string;
  signature: string;
}): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  if (!queueClient) {
    queueClient = createClient({ url }) as RedisClientType;
    queueClient.on("error", (error) => console.error("Redis webhook delivery queue error", error));
    await queueClient.connect();
  }
  await queueClient.xAdd(WEBHOOK_DELIVERY_QUEUE, "*", message);
}

export async function webhookRoutes(app: FastifyInstance, opts: WebhookRoutesOptions = {}) {
  const store = opts.store ?? new WebhookDeliveryStore((app as any).pg ?? null);
  const enqueue = opts.enqueue ?? enqueueToRedis;

  app.post("/webhooks/endpoints", async (req, reply) => {
    const body = parseBody(registerEndpointSchema, req.body, reply);
    if (!body) return reply;

    // enforce HTTPS in production — cleartext webhook targets can leak
    // signed payloads and are a stated security rule for this feature.
    if (process.env.NODE_ENV === "production" && !body.target_url.startsWith("https://")) {
      throw new ApiError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "target_url must use HTTPS in production",
      );
    }

    const endpoint = await store.registerEndpoint({
      userId: body.user_id,
      targetUrl: body.target_url,
    });

    return reply.status(201).send({
      endpoint_id: endpoint.endpointId,
      user_id: endpoint.userId,
      target_url: endpoint.targetUrl,
      secret_key: endpoint.secretKey,
      is_active: endpoint.isActive,
      created_at: endpoint.createdAt,
    });
  });

  app.get<{ Querystring: { user_id?: string } }>("/webhooks/endpoints", async (req) => {
    const userId = req.query.user_id;
    if (!userId) {
      throw new ApiError(400, ErrorCode.MISSING_FIELD, "user_id query parameter is required");
    }
    const endpoints = await store.listActiveEndpoints(userId);
    return {
      endpoints: endpoints.map((endpoint) => ({
        endpoint_id: endpoint.endpointId,
        user_id: endpoint.userId,
        target_url: endpoint.targetUrl,
        secret_key: endpoint.secretKey,
        is_active: endpoint.isActive,
        created_at: endpoint.createdAt,
      })),
    };
  });

  app.get<{ Params: { endpointId: string } }>(
    "/webhooks/endpoints/:endpointId/deliveries",
    async (req) => {
      const endpoint = await store.getEndpoint(req.params.endpointId);
      if (!endpoint) {
        throw new ApiError(404, ErrorCode.NOT_FOUND, "Webhook endpoint not found");
      }
      const deliveries = await store.listDeliveries(req.params.endpointId);
      return {
        deliveries: deliveries.map((log) => ({
          delivery_id: log.deliveryId,
          endpoint_id: log.endpointId,
          event_type: log.eventType,
          attempt_count: log.attemptCount,
          status: log.status,
          last_response_code: log.lastResponseCode,
          created_at: log.createdAt,
        })),
      };
    },
  );

  app.post("/webhooks/dlq/replay", async (req, reply) => {
    const body = parseBody(dlqReplaySchema, req.body, reply);
    if (!body) return reply;

    const claimed = await store.claimDeadLetterForReplay(body.delivery_id);
    if (!claimed) {
      throw new ApiError(
        409,
        ErrorCode.CONFLICT,
        "Delivery is not dead-lettered (already replayed, still in flight, or not found)",
      );
    }

    const endpoint = await store.getEndpoint(claimed.endpointId);
    if (!endpoint) {
      throw new ApiError(404, ErrorCode.NOT_FOUND, "Webhook endpoint for this delivery no longer exists");
    }

    // Re-stringify the exact envelope that was originally signed, so the
    // stored signature_header still verifies at the client.
    const payloadJson = JSON.stringify(claimed.payload);
    try {
      await enqueue({
        deliveryId: claimed.deliveryId,
        endpointId: claimed.endpointId,
        targetUrl: endpoint.targetUrl,
        payload: payloadJson,
        signature: claimed.signatureHeader,
      });
    } catch (error) {
      req.log.error(error, "webhook DLQ replay enqueue failed");
      throw new ApiError(502, ErrorCode.SERVICE_UNAVAILABLE, "Failed to re-enqueue delivery", {
        detail: String(error),
      });
    }

    return reply.status(202).send({
      delivery_id: claimed.deliveryId,
      status: claimed.status,
    });
  });
}
