/**
 * Distributed Multi-Node Webhook Event Delivery Engine — worker (#445).
 *
 * Drains `velo:webhook-delivery-queue` and actually performs the signed HTTP
 * POST to a developer's registered endpoint. This is deliberately separate
 * from the request thread that triggered the event (see webhook.ts's
 * `notifyDeveloperWebhooks`), so a slow or dead client endpoint never blocks
 * an API response.
 *
 * Retry policy mirrors sessionRotationWorker: exponential backoff with
 * jitter, up to `maxAttempts` (default 5) tries, then dead-lettered to
 * `velo:webhook-delivery-dlq` and marked DEAD_LETTER in
 * `webhook_delivery_logs` so an operator (or the DLQ replay API) can inspect
 * and re-queue it later.
 */
import {
  WEBHOOK_DELIVERY_DLQ,
  WEBHOOK_DELIVERY_GROUP,
  WEBHOOK_DELIVERY_QUEUE,
  WEBHOOK_DELIVERY_MAX_ATTEMPTS,
} from "@velo/shared";
import type { WebhookDeliveryStore } from "../webhookDeliveryStore.js";

export interface WebhookDeliveryMessage {
  deliveryId: string;
  endpointId: string;
  targetUrl: string;
  payload: string;
  signature: string;
}

export type WebhookDeliveryWorkerEvent =
  | { type: "delivered"; deliveryId: string; attempts: number; statusCode: number }
  | { type: "retry"; deliveryId: string; attempt: number; reason: string }
  | { type: "dead-letter"; deliveryId: string; reason: string };

/** Structural subset of the redis client this worker needs. */
export interface DeliveryQueueClient {
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
  xAdd(key: string, id: string, message: Record<string, string>): Promise<unknown>;
}

export interface WebhookDeliveryWorkerOptions {
  store: WebhookDeliveryStore;
  /** Redis mode. Omit to drain the in-memory `queue` array instead. */
  redis?: DeliveryQueueClient;
  /** In-memory queue used when no redis client is injected (dev / tests). */
  queue?: WebhookDeliveryMessage[];
  /** In-memory dead-letter sink used when no redis client is injected. */
  dlq?: WebhookDeliveryMessage[];
  pollIntervalMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  consumerName?: string;
  /** Injectable HTTP delivery, defaulting to a real signed fetch(). */
  deliver?: (message: WebhookDeliveryMessage) => Promise<{ ok: boolean; statusCode: number }>;
  onEvent?: (event: WebhookDeliveryWorkerEvent) => void;
  /** Injectable jitter source; defaults to Math.random. */
  random?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function deliverHttp(
  message: WebhookDeliveryMessage,
): Promise<{ ok: boolean; statusCode: number }> {
  try {
    const res = await fetch(message.targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-velo-signature": message.signature,
      },
      body: message.payload,
    });
    return { ok: res.ok, statusCode: res.status };
  } catch {
    return { ok: false, statusCode: 0 };
  }
}

function toMessage(fields: Record<string, string>): WebhookDeliveryMessage | null {
  if (!fields.deliveryId || !fields.endpointId || !fields.targetUrl || !fields.payload) {
    return null;
  }
  return {
    deliveryId: fields.deliveryId,
    endpointId: fields.endpointId,
    targetUrl: fields.targetUrl,
    payload: fields.payload,
    signature: fields.signature ?? "",
  };
}

interface StreamEntry {
  id: string;
  message: Record<string, string>;
}

/** node-redis returns either an array of streams or null when nothing is ready. */
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
    maxAttempts = WEBHOOK_DELIVERY_MAX_ATTEMPTS,
    baseDelayMs = 1_000,
    consumerName = `webhook-delivery-${process.pid}`,
    deliver = deliverHttp,
    onEvent,
    random = Math.random,
  } = options;

  let stopped = false;
  let ticking = false;
  let groupReady = !redis;

  async function deadLetter(message: WebhookDeliveryMessage, reason: string): Promise<void> {
    if (redis) {
      await redis
        .xAdd(WEBHOOK_DELIVERY_DLQ, "*", {
          deliveryId: message.deliveryId,
          endpointId: message.endpointId,
          targetUrl: message.targetUrl,
          reason,
        })
        .catch(() => undefined);
    } else {
      dlq?.push(message);
    }
    onEvent?.({ type: "dead-letter", deliveryId: message.deliveryId, reason });
  }

  async function handleMessage(message: WebhookDeliveryMessage): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let reason: string;
      let responseCode: number | null = null;
      try {
        const result = await deliver(message);
        if (result.ok) {
          await store.recordAttempt(message.deliveryId, {
            status: "DELIVERED",
            lastResponseCode: result.statusCode,
          });
          onEvent?.({
            type: "delivered",
            deliveryId: message.deliveryId,
            attempts: attempt + 1,
            statusCode: result.statusCode,
          });
          return;
        }
        reason = `endpoint returned ${result.statusCode}`;
        responseCode = result.statusCode || null;
      } catch (error) {
        reason = String(error);
      }

      // One recordAttempt per actual delivery attempt — the final attempt
      // records DEAD_LETTER directly rather than FAILED-then-DEAD_LETTER, so
      // attempt_count matches the number of HTTP attempts actually made.
      const isFinalAttempt = attempt + 1 >= maxAttempts;
      await store.recordAttempt(message.deliveryId, {
        status: isFinalAttempt ? "DEAD_LETTER" : "FAILED",
        lastResponseCode: responseCode,
      });

      onEvent?.({ type: "retry", deliveryId: message.deliveryId, attempt: attempt + 1, reason });
      if (isFinalAttempt) {
        await deadLetter(message, reason);
        return;
      }
      // Exponential backoff with jitter so retries of a batch never align.
      await sleep(baseDelayMs * 2 ** attempt + Math.floor(random() * baseDelayMs));
    }
  }

  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      if (!redis) {
        while (!stopped && queue.length > 0) {
          await handleMessage(queue.shift() as WebhookDeliveryMessage);
        }
        return;
      }
      if (!groupReady) {
        await redis
          .xGroupCreate(WEBHOOK_DELIVERY_QUEUE, WEBHOOK_DELIVERY_GROUP, "0", { MKSTREAM: true })
          .catch(() => undefined);
        groupReady = true;
      }
      const response = await redis.xReadGroup(
        WEBHOOK_DELIVERY_GROUP,
        consumerName,
        [{ key: WEBHOOK_DELIVERY_QUEUE, id: ">" }],
        { COUNT: 10 },
      );
      for (const entry of readEntries(response)) {
        const message = toMessage(entry.message);
        if (message) await handleMessage(message);
        await redis.xAck(WEBHOOK_DELIVERY_QUEUE, WEBHOOK_DELIVERY_GROUP, entry.id);
      }
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    void tick().catch(() => undefined);
  }, pollIntervalMs);
  // Never keep the process alive just for the delivery drain loop.
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
