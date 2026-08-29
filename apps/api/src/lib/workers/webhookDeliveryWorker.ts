/**
 * Distributed Multi-Node Webhook Event Delivery Engine & DLQ Worker (Issue #445)
 *
 * Consumes events from Redis Stream `velo:webhook-delivery-queue`, signs payloads with HMAC-SHA256,
 * delivers HTTP POST requests to registered endpoints, and retries failed deliveries with
 * exponential backoff up to 5 attempts before moving to Dead-Letter Queue (DLQ).
 */
import {
  WEBHOOK_DELIVERY,
  type WebhookDeliveryMessage,
  type WebhookDeliveryStatus,
} from "@velo/shared";
import type { WebhookStore } from "../webhook-store.js";
import { generateWebhookSignature } from "../webhook.js";

export type WebhookDeliveryWorkerEvent =
  | { type: "delivered"; deliveryId: string; attempts: number; statusCode: number }
  | { type: "retry"; deliveryId: string; attempt: number; reason: string; statusCode?: number }
  | { type: "dead-letter"; deliveryId: string; reason: string; statusCode?: number };

/** Structural subset of the Redis client needed by the worker. */
export interface WebhookQueueClient {
  xGroupCreate(
    key: string,
    group: string,
    id: string,
    options?: { MKSTREAM?: boolean },
  ): Promise<unknown>;
  xReadGroup(
    group: string,
    consumer: string,
    streams: Array<{ key: string; id: string }>,
    options?: { COUNT?: number },
  ): Promise<unknown>;
  xAck(key: string, group: string, id: string): Promise<unknown>;
  xAdd(
    key: string,
    id: string,
    message: Record<string, string>,
  ): Promise<unknown>;
}

export interface WebhookDeliveryWorkerOptions {
  store: WebhookStore;
  /** Redis client. If omitted, uses in-memory queue array (dev / tests). */
  redis?: WebhookQueueClient;
  /** In-memory queue used when no Redis client is provided. */
  queue?: WebhookDeliveryMessage[];
  /** In-memory dead-letter sink used when no Redis client is provided. */
  dlq?: WebhookDeliveryMessage[];
  pollIntervalMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  consumerName?: string;
  onEvent?: (event: WebhookDeliveryWorkerEvent) => void;
  /** Injectable fetch implementation; defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Injectable jitter source; defaults to Math.random. */
  random?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function toDeliveryMessage(
  fields: Record<string, string>,
): WebhookDeliveryMessage | null {
  if (!fields.deliveryId || !fields.endpointId || !fields.targetUrl) {
    return null;
  }
  return {
    deliveryId: fields.deliveryId,
    endpointId: fields.endpointId,
    targetUrl: fields.targetUrl,
    secretKey: fields.secretKey || "",
    eventType: fields.eventType || "unknown",
    payload: fields.payload || "{}",
    signatureHeader: fields.signatureHeader || "",
    attemptCount: fields.attemptCount ? Number(fields.attemptCount) : 0,
  };
}

interface StreamEntry {
  id: string;
  message: Record<string, string>;
}

function readEntries(response: unknown): StreamEntry[] {
  if (!Array.isArray(response)) return [];
  const entries: StreamEntry[] = [];
  for (const stream of response as Array<{ messages?: StreamEntry[] }>) {
    for (const entry of stream?.messages ?? []) entries.push(entry);
  }
  return entries;
}

export function startWebhookDeliveryWorker(
  options: WebhookDeliveryWorkerOptions,
): () => void {
  const {
    store,
    redis,
    queue = [],
    dlq,
    pollIntervalMs = 1_000,
    maxAttempts = WEBHOOK_DELIVERY.MAX_ATTEMPTS,
    baseDelayMs = WEBHOOK_DELIVERY.BASE_DELAY_MS,
    consumerName = `webhook-worker-${process.pid}`,
    onEvent,
    fetchFn = globalThis.fetch,
    random = Math.random,
  } = options;

  let stopped = false;
  let ticking = false;
  let groupReady = !redis;

  async function routeToDlq(
    message: WebhookDeliveryMessage,
    reason: string,
    statusCode?: number,
  ): Promise<void> {
    await store.updateDeliveryStatus(
      message.deliveryId,
      "DEAD_LETTER",
      maxAttempts,
      statusCode ?? null,
    );

    if (redis) {
      await redis
        .xAdd(WEBHOOK_DELIVERY.DLQ, "*", {
          deliveryId: message.deliveryId,
          endpointId: message.endpointId,
          targetUrl: message.targetUrl,
          eventType: message.eventType,
          payload: message.payload,
          reason,
          statusCode: statusCode !== undefined ? String(statusCode) : "",
        })
        .catch(() => undefined);
    } else {
      dlq?.push(message);
    }

    onEvent?.({
      type: "dead-letter",
      deliveryId: message.deliveryId,
      reason,
      statusCode,
    });
  }

  async function handleMessage(
    message: WebhookDeliveryMessage,
  ): Promise<void> {
    const signature =
      message.signatureHeader ||
      generateWebhookSignature(message.payload, message.secretKey);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let statusCode: number | undefined = undefined;
      let reason: string;

      try {
        const res = await fetchFn(message.targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-velo-signature": signature,
            "x-velo-event": message.eventType,
            "x-velo-delivery-id": message.deliveryId,
          },
          body:
            typeof message.payload === "string"
              ? message.payload
              : JSON.stringify(message.payload),
        });

        statusCode = res.status;

        if (res.ok) {
          await store.updateDeliveryStatus(
            message.deliveryId,
            "DELIVERED",
            attempt + 1,
            statusCode,
          );
          onEvent?.({
            type: "delivered",
            deliveryId: message.deliveryId,
            attempts: attempt + 1,
            statusCode,
          });
          return;
        }

        reason = `HTTP request failed with status ${res.status}`;
      } catch (error) {
        reason = String(error);
      }

      onEvent?.({
        type: "retry",
        deliveryId: message.deliveryId,
        attempt: attempt + 1,
        reason,
        statusCode,
      });

      if (attempt + 1 >= maxAttempts) {
        await routeToDlq(message, reason, statusCode);
        return;
      }

      // Update attempt count in store between retries
      await store.updateDeliveryStatus(
        message.deliveryId,
        "FAILED",
        attempt + 1,
        statusCode ?? null,
      );

      // Exponential backoff: delayMs = 1000 * 2^attempt + jitter
      const delayMs =
        baseDelayMs * 2 ** attempt + Math.floor(random() * (baseDelayMs / 2));
      await sleep(delayMs);
    }
  }

  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      if (!redis) {
        while (!stopped && queue.length > 0) {
          const item = queue.shift();
          if (item) await handleMessage(item);
        }
        return;
      }

      if (!groupReady) {
        await redis
          .xGroupCreate(
            WEBHOOK_DELIVERY.QUEUE,
            WEBHOOK_DELIVERY.GROUP,
            "0",
            { MKSTREAM: true },
          )
          .catch(() => undefined);
        groupReady = true;
      }

      const response = await redis.xReadGroup(
        WEBHOOK_DELIVERY.GROUP,
        consumerName,
        [{ key: WEBHOOK_DELIVERY.QUEUE, id: ">" }],
        { COUNT: 10 },
      );

      for (const entry of readEntries(response)) {
        const message = toDeliveryMessage(entry.message);
        if (message) await handleMessage(message);
        await redis.xAck(
          WEBHOOK_DELIVERY.QUEUE,
          WEBHOOK_DELIVERY.GROUP,
          entry.id,
        );
      }
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    void tick().catch(() => undefined);
  }, pollIntervalMs);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
