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
