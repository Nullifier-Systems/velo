import { describe, expect, it, vi } from "vitest";
import { WebhookDeliveryStore } from "../webhookDeliveryStore.js";
import {
  startWebhookDeliveryWorker,
  type WebhookDeliveryMessage,
  type WebhookDeliveryWorkerEvent,
} from "./webhookDeliveryWorker.js";

async function seed(): Promise<{ store: WebhookDeliveryStore; message: WebhookDeliveryMessage }> {
  const store = new WebhookDeliveryStore();
  const endpoint = await store.registerEndpoint({
    userId: "GALICEALICEALICEALICEALICEALICEALICEALICEALICEALICEALIC",
    targetUrl: "https://developer.example.com/velo-webhook",
  });
  const log = await store.createDeliveryLog({
    endpointId: endpoint.endpointId,
    eventType: "REFUNDED",
    payload: { type: "REFUNDED", data: { trade_id: "t1" } },
    signatureHeader: "deadbeef",
  });
  return {
    store,
    message: {
      deliveryId: log.deliveryId,
      endpointId: endpoint.endpointId,
      targetUrl: endpoint.targetUrl,
      payload: JSON.stringify({ type: "REFUNDED", data: { trade_id: "t1" } }),
      signature: "deadbeef",
    },
  };
}

function waitFor(
  events: WebhookDeliveryWorkerEvent[],
  type: WebhookDeliveryWorkerEvent["type"],
): Promise<WebhookDeliveryWorkerEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = setInterval(() => {
      const found = events.find((event) => event.type === type);
      if (found) {
        clearInterval(poll);
        resolve(found);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`no ${type} event within 5s`));
      }
    }, 5);
  });
}

describe("webhook delivery worker (#445)", () => {
  it("marks a delivery DELIVERED on the first successful attempt", async () => {
    const { store, message } = await seed();
    const events: WebhookDeliveryWorkerEvent[] = [];
    const deliver = vi.fn().mockResolvedValue({ ok: true, statusCode: 200 });
    const stop = startWebhookDeliveryWorker({
      store,
      queue: [message],
      pollIntervalMs: 1,
      baseDelayMs: 1,
      deliver,
      onEvent: (event) => events.push(event),
    });

    const delivered = await waitFor(events, "delivered");
    stop();

    expect(delivered).toMatchObject({ deliveryId: message.deliveryId, attempts: 1, statusCode: 200 });
    const log = await store.getDelivery(message.deliveryId);
    expect(log?.status).toBe("DELIVERED");
    expect(log?.attemptCount).toBe(1);
  });

  it("retries five times with backoff then dead-letters the delivery", async () => {
    const { store, message } = await seed();
    const events: WebhookDeliveryWorkerEvent[] = [];
    const dlq: WebhookDeliveryMessage[] = [];
    const deliver = vi.fn().mockResolvedValue({ ok: false, statusCode: 503 });
    const stop = startWebhookDeliveryWorker({
      store,
      queue: [message],
      dlq,
      pollIntervalMs: 1,
      baseDelayMs: 1,
      random: () => 0.5,
      deliver,
      onEvent: (event) => events.push(event),
    });

    await waitFor(events, "dead-letter");
    stop();

    expect(deliver).toHaveBeenCalledTimes(5);
    expect(events.filter((event) => event.type === "retry")).toHaveLength(5);
    expect(dlq).toEqual([message]);
    const log = await store.getDelivery(message.deliveryId);
    expect(log?.status).toBe("DEAD_LETTER");
    expect(log?.attemptCount).toBe(5);
  });

  it("sends the HMAC signature as the x-velo-signature header", async () => {
    const { store, message } = await seed();
    const events: WebhookDeliveryWorkerEvent[] = [];
    const seenHeaders: Record<string, string>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      seenHeaders.push(init.headers as Record<string, string>);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const stop = startWebhookDeliveryWorker({
      store,
      queue: [message],
      pollIntervalMs: 1,
      baseDelayMs: 1,
      onEvent: (event) => events.push(event),
    });

    await waitFor(events, "delivered");
    stop();
    globalThis.fetch = originalFetch;

    expect(seenHeaders[0]["x-velo-signature"]).toBe(message.signature);
  });
});
