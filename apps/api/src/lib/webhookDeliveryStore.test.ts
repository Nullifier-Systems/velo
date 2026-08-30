import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { signWebhookPayload } from "./webhook.js";
import { WebhookDeliveryStore } from "./webhookDeliveryStore.js";

describe("signWebhookPayload (#445)", () => {
  it("computes HMAC-SHA256 of the exact payload bytes with the endpoint secret", () => {
    const payload = JSON.stringify({ type: "REFUNDED", data: { trade_id: "abc" } });
    const secret = "s3cr3t";
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    expect(signWebhookPayload(payload, secret)).toBe(expected);
  });

  it("produces a different signature for a different secret", () => {
    const payload = JSON.stringify({ type: "REFUNDED", data: { trade_id: "abc" } });
    expect(signWebhookPayload(payload, "secret-a")).not.toBe(signWebhookPayload(payload, "secret-b"));
  });

  it("produces a different signature when the payload changes by one byte", () => {
    const secret = "s3cr3t";
    const a = signWebhookPayload(JSON.stringify({ trade_id: "abc" }), secret);
    const b = signWebhookPayload(JSON.stringify({ trade_id: "abd" }), secret);
    expect(a).not.toBe(b);
  });
});

describe("WebhookDeliveryStore (#445, in-memory mode)", () => {
  it("registers an endpoint with a 64-hex-char secret key", async () => {
    const store = new WebhookDeliveryStore();
    const endpoint = await store.registerEndpoint({
      userId: "GALICE",
      targetUrl: "https://example.com/hook",
    });
    expect(endpoint.secretKey).toMatch(/^[0-9a-f]{64}$/);
    expect(endpoint.isActive).toBe(true);
  });

  it("lists only active endpoints for the given user", async () => {
    const store = new WebhookDeliveryStore();
    await store.registerEndpoint({ userId: "GALICE", targetUrl: "https://a.example.com" });
    await store.registerEndpoint({ userId: "GBOB", targetUrl: "https://b.example.com" });
    const endpoints = await store.listActiveEndpoints("GALICE");
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].targetUrl).toBe("https://a.example.com");
  });

  it("claimDeadLetterForReplay is a no-op unless the delivery is DEAD_LETTER", async () => {
    const store = new WebhookDeliveryStore();
    const endpoint = await store.registerEndpoint({ userId: "GALICE", targetUrl: "https://a.example.com" });
    const log = await store.createDeliveryLog({
      endpointId: endpoint.endpointId,
      eventType: "REFUNDED",
      payload: { trade_id: "t1" },
      signatureHeader: "sig",
    });

    // Still QUEUED — replay must refuse.
    expect(await store.claimDeadLetterForReplay(log.deliveryId)).toBeNull();

    await store.recordAttempt(log.deliveryId, { status: "DEAD_LETTER", lastResponseCode: 503 });
    const claimed = await store.claimDeadLetterForReplay(log.deliveryId);
    expect(claimed?.status).toBe("QUEUED");

    // Second replay of the same (now QUEUED, not DEAD_LETTER) delivery is a no-op.
    expect(await store.claimDeadLetterForReplay(log.deliveryId)).toBeNull();
  });
});
