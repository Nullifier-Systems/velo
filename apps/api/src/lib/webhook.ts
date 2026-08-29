import "dotenv/config";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  WEBHOOK_DELIVERY,
  type WebhookDeliveryLog,
  type WebhookEndpoint,
} from "@velo/shared";
import type { WebhookStore } from "./webhook-store.js";
import type { WebhookQueueClient } from "./workers/webhookDeliveryWorker.js";

const WEBHOOK_URL = process.env.REFUND_WEBHOOK_URL;

function isDiscord(url: string): boolean {
  return /discord\.com|discordapp\.com/i.test(url);
}

export interface WebhookAlert {
  title: string;
  text: string;
  fields: Record<string, string>;
}

/**
 * Calculates HMAC-SHA256 signature for payload using secret_key.
 * Returns a 64-character lowercase hex string.
 */
export function generateWebhookSignature(
  payload: string | Record<string, unknown>,
  secretKey: string,
): string {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return createHmac("sha256", secretKey).update(data).digest("hex");
}

/**
 * Verifies payload against expected HMAC-SHA256 signature in constant time.
 */
export function verifyWebhookSignature(
  payload: string | Record<string, unknown>,
  secretKey: string,
  signature: string,
): boolean {
  if (!signature || typeof signature !== "string") return false;
  const expected = generateWebhookSignature(payload, secretKey);
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

/**
 * Generates a 32-byte secure random secret key (64 hex characters).
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Validates endpoint URL. Enforces HTTPS in production.
 */
export function validateWebhookUrl(
  url: string,
  enforceHttps = process.env.NODE_ENV === "production",
): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (enforceHttps) {
      return parsed.protocol === "https:";
    }
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Enqueues a webhook delivery log in DB and publishes to Redis stream.
 */
export async function enqueueWebhookDelivery(params: {
  store: WebhookStore;
  redis?: WebhookQueueClient;
  endpoint: WebhookEndpoint;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<WebhookDeliveryLog> {
  const { store, redis, endpoint, eventType, payload } = params;
  const signature = generateWebhookSignature(payload, endpoint.secretKey);

  const log = await store.createDeliveryLog({
    endpointId: endpoint.endpointId,
    eventType,
    payload,
    signatureHeader: signature,
    status: "QUEUED",
    attemptCount: 0,
    lastResponseCode: null,
  });

  if (redis) {
    await redis.xAdd(WEBHOOK_DELIVERY.QUEUE, "*", {
      deliveryId: log.deliveryId,
      endpointId: endpoint.endpointId,
      targetUrl: endpoint.targetUrl,
      secretKey: endpoint.secretKey,
      eventType,
      payload: JSON.stringify(payload),
      signatureHeader: signature,
    });
  }

  return log;
}

/**
 * Dispatches a webhook event to all active endpoints for a given user (or globally).
 */
export async function dispatchWebhookEvent(params: {
  store: WebhookStore;
  redis?: WebhookQueueClient;
  eventType: string;
  payload: Record<string, unknown>;
  userId?: string;
}): Promise<WebhookDeliveryLog[]> {
  const { store, redis, eventType, payload, userId } = params;
  const endpoints = await store.findActiveEndpointsForUser(userId);
  const logs: WebhookDeliveryLog[] = [];

  for (const endpoint of endpoints) {
    const log = await enqueueWebhookDelivery({
      store,
      redis,
      endpoint,
      eventType,
      payload,
    });
    logs.push(log);
  }

  return logs;
}

/** Send an operations alert through the existing Slack/Discord webhook (non-blocking). */
export async function sendWebhookAlert(alert: WebhookAlert): Promise<void> {
  if (!WEBHOOK_URL) return;

  const fields = Object.entries(alert.fields);
  const payload = isDiscord(WEBHOOK_URL)
    ? {
        content: alert.text,
        embeds: [
          {
            title: alert.title,
            fields: fields.map(([name, value]) => ({
              name,
              value,
              inline: true,
            })),
          },
        ],
      }
    : {
        text: alert.text,
        blocks: [
          { type: "header", text: { type: "plain_text", text: alert.title } },
          {
            type: "section",
            fields: fields.map(([name, value]) => ({
              type: "mrkdwn",
              text: `*${name}*\n${value}`,
            })),
          },
        ],
      };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`webhook returned ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error("webhook call failed:", err);
  }
}

export async function sendRefundAlert(params: {
  tradeId: string;
  amountStroops: string;
  buyer: string;
  seller: string;
  webhookStore?: WebhookStore;
  redis?: WebhookQueueClient;
}): Promise<void> {
  const { tradeId, amountStroops, buyer, seller, webhookStore, redis } = params;
  const amountUsdc = (Number(amountStroops) / 10_000_000).toFixed(2);

  // Operations channel alert
  void sendWebhookAlert({
    title: "Refund processed",
    text: `Refund processed — trade \`${tradeId}\`, ${amountUsdc} USDC`,
    fields: {
      "Trade ID": `\`${tradeId}\``,
      Amount: `${amountUsdc} USDC`,
      Buyer: `\`${buyer}\``,
      Seller: `\`${seller}\``,
    },
  }).catch((err) => console.error("sendRefundAlert webhook failed:", err));

  // If webhook store is available, offload to client endpoints
  if (webhookStore) {
    void dispatchWebhookEvent({
      store: webhookStore,
      redis,
      eventType: "trade.refunded",
      payload: {
        tradeId,
        amountStroops,
        amountUsdc,
        buyer,
        seller,
        timestamp: new Date().toISOString(),
      },
    }).catch((err) =>
      console.error("dispatchWebhookEvent trade.refunded failed:", err),
    );
  }
}

/**
 * Pre-expiry countdown warning: a locked (or partially released) trade is
 * approaching its refund timeout. This is the heads-up that fires BEFORE the
 * timeout, so operators know a permissionless refund is imminent. It is the
 * counterpart to sendRefundAlert() above, which fires AFTER a refund settles.
 */
export async function sendRefundCountdownAlert(params: {
  tradeId: string;
  amountStroops: string;
  buyer: string;
  seller: string;
  timeoutLedger: number;
  latestLedger: number;
  ledgersUntilRefund: number;
  estimatedSecondsUntilRefund: number;
  webhookStore?: WebhookStore;
  redis?: WebhookQueueClient;
}): Promise<void> {
  const {
    tradeId,
    amountStroops,
    buyer,
    seller,
    timeoutLedger,
    latestLedger,
    ledgersUntilRefund,
    estimatedSecondsUntilRefund,
    webhookStore,
    redis,
  } = params;
  const amountUsdc = (Number(amountStroops) / 10_000_000).toFixed(2);
  const etaMinutes = Math.max(1, Math.round(estimatedSecondsUntilRefund / 60));

  void sendWebhookAlert({
    title: "Refund countdown",
    text: `Trade \`${tradeId}\` becomes refundable in ${ledgersUntilRefund} ledger(s), about ${etaMinutes} min.`,
    fields: {
      "Trade ID": `\`${tradeId}\``,
      Amount: `${amountUsdc} USDC`,
      "Ledgers until refund": String(ledgersUntilRefund),
      "Timeout ledger": String(timeoutLedger),
      "Latest ledger": String(latestLedger),
      Buyer: `\`${buyer}\``,
      Seller: `\`${seller}\``,
    },
  }).catch((err) =>
    console.error("sendRefundCountdownAlert webhook failed:", err),
  );

  if (webhookStore) {
    void dispatchWebhookEvent({
      store: webhookStore,
      redis,
      eventType: "trade.refund_countdown",
      payload: {
        tradeId,
        amountStroops,
        amountUsdc,
        buyer,
        seller,
        timeoutLedger,
        latestLedger,
        ledgersUntilRefund,
        estimatedSecondsUntilRefund,
        timestamp: new Date().toISOString(),
      },
    }).catch((err) =>
      console.error(
        "dispatchWebhookEvent trade.refund_countdown failed:",
        err,
      ),
    );
  }
}

/**
 * Swap dispute bridge alert: tracks atomic swap dispute status transitions.
 */
export async function sendSwapDisputeAlert(params: {
  swapId: string;
  state: string;
  initiatorAddress: string;
  counterpartyAddress: string;
  reason?: string;
}): Promise<void> {
  const { swapId, state, initiatorAddress, counterpartyAddress, reason } =
    params;
  await sendWebhookAlert({
    title: "Atomic Swap Dispute Event",
    text: `Atomic swap \`${swapId}\` transitioned to \`${state}\`${reason ? `: ${reason}` : ""}`,
    fields: {
      "Swap ID": `\`${swapId}\``,
      State: state,
      Initiator: `\`${initiatorAddress}\``,
      Counterparty: `\`${counterpartyAddress}\``,
      ...(reason ? { Reason: reason } : {}),
    },
  });
}

/**
 * Secret extraction alert: fired when dual-side secret extraction extracts a preimage from on-chain logs.
 */
export async function sendSwapSecretExtractedAlert(params: {
  swapId: string;
  secret: string;
  chain: string;
  blockOrLedger?: number;
}): Promise<void> {
  const { swapId, secret, chain, blockOrLedger } = params;
  await sendWebhookAlert({
    title: "Atomic Swap Secret Extracted",
    text: `Preimage extracted for swap \`${swapId}\` on chain \`${chain}\``,
    fields: {
      "Swap ID": `\`${swapId}\``,
      Chain: chain,
      Secret: `\`${secret}\``,
      ...(blockOrLedger ? { "Block/Ledger": String(blockOrLedger) } : {}),
    },
  });
}

/**
 * Swap dispute refund trigger alert: fired when an expired swap triggers automatic dispute refund.
 */
export async function sendSwapDisputeRefundAlert(params: {
  swapId: string;
  recipient: string;
  expirationLedger: number;
  currentLedger: number;
}): Promise<void> {
  const { swapId, recipient, expirationLedger, currentLedger } = params;
  await sendWebhookAlert({
    title: "Atomic Swap Dispute Refund Triggered",
    text: `Automatic refund claim executed for expired swap \`${swapId}\``,
    fields: {
      "Swap ID": `\`${swapId}\``,
      Recipient: `\`${recipient}\``,
      "Expiration Ledger": String(expirationLedger),
      "Current Ledger": String(currentLedger),
    },
  });
}
