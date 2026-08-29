import "dotenv/config";

const WEBHOOK_URL = process.env.REFUND_WEBHOOK_URL;

function isDiscord(url: string): boolean {
  return /discord\.com|discordapp\.com/i.test(url);
}

export interface WebhookAlert {
  title: string;
  text: string;
  fields: Record<string, string>;
}

/** Send an operations alert through the existing Slack/Discord webhook. */
export async function sendWebhookAlert(alert: WebhookAlert): Promise<void> {
  if (!WEBHOOK_URL) return;

  const fields = Object.entries(alert.fields);
  const payload = isDiscord(WEBHOOK_URL)
    ? {
        content: alert.text,
        embeds: [{ title: alert.title, fields: fields.map(([name, value]) => ({ name, value, inline: true })) }],
      }
    : {
        text: alert.text,
        blocks: [
          { type: "header", text: { type: "plain_text", text: alert.title } },
          { type: "section", fields: fields.map(([name, value]) => ({ type: "mrkdwn", text: `*${name}*\n${value}` })) },
        ],
      };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error(`webhook returned ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error("webhook call failed:", err);
  }
}

export async function sendRefundAlert(params: {
  tradeId: string;
  amountStroops: string;
  buyer: string;
  seller: string;
}): Promise<void> {
  const { tradeId, amountStroops, buyer, seller } = params;
  const amountUsdc = (Number(amountStroops) / 10_000_000).toFixed(2);
  await sendWebhookAlert({
    title: "Refund processed",
    text: `Refund processed — trade \`${tradeId}\`, ${amountUsdc} USDC`,
    fields: {
      "Trade ID": `\`${tradeId}\``,
      Amount: `${amountUsdc} USDC`,
      Buyer: `\`${buyer}\``,
      Seller: `\`${seller}\``,
    },
  });
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
  } = params;
  const amountUsdc = (Number(amountStroops) / 10_000_000).toFixed(2);
  const etaMinutes = Math.max(1, Math.round(estimatedSecondsUntilRefund / 60));
  await sendWebhookAlert({
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
  });
}

/**
 * A cross-chain swap's preimage was observed on-chain and stored off-chain.
 *
 * This is the "secret is safe now" signal: until it fires, the preimage
 * exists only in an event log, and missing it means the collateral cannot be
 * recovered. Operators want to see this land well before the local timeout.
 */
export async function sendSwapSecretExtractedAlert(params: {
  swapId: string;
  secretHash: string;
  initiator: string;
  counterparty: string;
  extractedAtLedger: number;
  expirationLedger: number;
}): Promise<void> {
  const {
    swapId,
    secretHash,
    initiator,
    counterparty,
    extractedAtLedger,
    expirationLedger,
  } = params;
  await sendWebhookAlert({
    title: "Swap secret extracted",
    text: `Preimage for swap \`${swapId}\` extracted at ledger ${extractedAtLedger} and stored off-chain.`,
    fields: {
      "Swap ID": `\`${swapId}\``,
      "Secret hash": `\`${secretHash}\``,
      "Extracted at ledger": String(extractedAtLedger),
      "Expiration ledger": String(expirationLedger),
      "Ledgers to spare": String(Math.max(0, expirationLedger - extractedAtLedger)),
      Initiator: `\`${initiator}\``,
      Counterparty: `\`${counterparty}\``,
    },
  });
}

/**
 * A swap expired without either side revealing, and an automated refund has
 * been claimed for the honest party.
 *
 * Fired by whichever caller won the `SELECT ... FOR UPDATE` claim, so this
 * alert appears exactly once per swap even when the worker and an operator
 * race each other.
 */
export async function sendSwapRefundClaimedAlert(params: {
  swapId: string;
  initiator: string;
  counterparty: string;
  expirationLedger: number;
  latestLedger: number;
  txHash?: string | null;
}): Promise<void> {
  const { swapId, initiator, counterparty, expirationLedger, latestLedger, txHash } = params;
  await sendWebhookAlert({
    title: "Swap refund claimed",
    text: `Swap \`${swapId}\` expired without a revealed secret — automated refund claimed.`,
    fields: {
      "Swap ID": `\`${swapId}\``,
      "Expiration ledger": String(expirationLedger),
      "Latest ledger": String(latestLedger),
      "Ledgers overdue": String(Math.max(0, latestLedger - expirationLedger)),
      Initiator: `\`${initiator}\``,
      Counterparty: `\`${counterparty}\``,
      ...(txHash ? { "Tx hash": `\`${txHash}\`` } : {}),
    },
  });
}

/**
 * A swap is inside the warning margin and still has no revealed secret.
 *
 * The counterpart to the two alerts above: it fires *before* expiry, while an
 * operator can still intervene, rather than reporting a lockup after the fact.
 */
export async function sendSwapExpiryWarningAlert(params: {
  swapId: string;
  initiator: string;
  counterparty: string;
  expirationLedger: number;
  latestLedger: number;
  estimatedSecondsUntilExpiry: number;
}): Promise<void> {
  const {
    swapId,
    initiator,
    counterparty,
    expirationLedger,
    latestLedger,
    estimatedSecondsUntilExpiry,
  } = params;
  const ledgersLeft = Math.max(0, expirationLedger - latestLedger);
  const etaMinutes = Math.max(1, Math.round(estimatedSecondsUntilExpiry / 60));
  await sendWebhookAlert({
    title: "Swap approaching expiry",
    text: `Swap \`${swapId}\` expires in ${ledgersLeft} ledger(s), about ${etaMinutes} min, with no secret revealed.`,
    fields: {
      "Swap ID": `\`${swapId}\``,
      "Ledgers until expiry": String(ledgersLeft),
      "Expiration ledger": String(expirationLedger),
      "Latest ledger": String(latestLedger),
      Initiator: `\`${initiator}\``,
      Counterparty: `\`${counterparty}\``,
    },
  });
}
