import "dotenv/config";

const WEBHOOK_URL = process.env.REFUND_WEBHOOK_URL;

function isDiscord(url: string): boolean {
  return /discord\.com|discordapp\.com/i.test(url);
}

export async function sendRefundAlert(params: {
  tradeId: string;
  amountStroops: string;
  buyer: string;
  seller: string;
}): Promise<void> {
  if (!WEBHOOK_URL) {
    return;
  }

  const { tradeId, amountStroops, buyer, seller } = params;
  const amountUsdc = (Number(amountStroops) / 10_000_000).toFixed(2);

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "Refund processed" } },
    { type: "section", fields: [
      { type: "mrkdwn", text: `*Trade ID*\n\`${tradeId}\`` },
      { type: "mrkdwn", text: `*Amount*\n${amountUsdc} USDC` },
    ]},
    { type: "section", fields: [
      { type: "mrkdwn", text: `*Buyer*\n\`${buyer}\`` },
      { type: "mrkdwn", text: `*Seller*\n\`${seller}\`` },
    ]},
  ];

  const payload = isDiscord(WEBHOOK_URL)
    ? { content: `Refund processed — trade \`${tradeId}\`, ${amountUsdc} USDC`, embeds: [{ title: "Refund processed", fields: [
        { name: "Trade ID", value: `\`${tradeId}\``, inline: true },
        { name: "Amount", value: `${amountUsdc} USDC`, inline: true },
        { name: "Buyer", value: `\`${buyer}\``, inline: true },
        { name: "Seller", value: `\`${seller}\``, inline: true },
      ]}]}
    : { text: `Refund processed — trade \`${tradeId}\`, ${amountUsdc} USDC`, blocks };

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
