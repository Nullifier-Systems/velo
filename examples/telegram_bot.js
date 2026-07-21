#!/usr/bin/env node

/**
 * Worked Example: Telegram Bot Calling Velo API End-to-End
 *
 * This example demonstrates how an AI agent or automated bot interacts with the Velo API:
 * 1. Queries nearby cash providers via GET /api/v1/cash/agents
 * 2. Creates a cash request via POST /api/v1/cash/request
 * 3. Extracts and displays the resulting claim_url to the Telegram user.
 *
 * Requirements:
 * - Node.js v18+ (uses native fetch and crypto)
 * - TELEGRAM_BOT_TOKEN environment variable (optional; if omitted or --test flag is passed, runs in test mode)
 *
 * Usage:
 *   # Live Bot Mode (polling Telegram API):
 *   export TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
 *   export VELO_API_URL="http://localhost:3000"
 *   node examples/telegram_bot.js
 *
 *   # Terminal Test / Simulation Mode:
 *   node examples/telegram_bot.js --test
 */

import crypto from 'node:crypto';

// Configuration from environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VELO_API_URL = (process.env.VELO_API_URL || 'http://localhost:3000').replace(/\/$/, '');

// Default Stellar G-addresses for demo purposes (can be overridden via ENV)
const SELLER_ADDRESS =
  process.env.SELLER_ADDRESS || 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYFRE6YAW455TNH2W6S';
const BUYER_ADDRESS =
  process.env.BUYER_ADDRESS || 'GAAZI4TCR3TY5OJHCTJC2A4QQSY6GJEGVR6Ch2FFM6ZXZIJFFA5N7EFE';
const X_PAYMENT_HEADER = process.env.X_PAYMENT_HEADER || '';

/**
 * Utility: Generate a random 32-byte secret and return secret + SHA-256 hash
 */
function createSecretAndHash() {
  const secretBytes = crypto.randomBytes(32);
  const secretHex = secretBytes.toString('hex');
  const secretHashHex = crypto.createHash('sha256').update(secretBytes).digest('hex');
  return { secretHex, secretHashHex };
}

/**
 * 1. Fetch nearby cash agents from Velo API (/api/v1/cash/agents)
 */
async function fetchCashAgents(options = {}) {
  const { lat = 37.7749, lng = -122.4194, radius = 5 } = options;
  const url = `${VELO_API_URL}/api/v1/cash/agents?lat=${lat}&lng=${lng}&radius=${radius}`;

  const headers = {};
  if (X_PAYMENT_HEADER) {
    headers['x-payment'] = X_PAYMENT_HEADER;
  }

  const response = await fetch(url, { headers });

  if (response.status === 402) {
    const data = await response.json();
    return {
      success: false,
      status: 402,
      error: 'x402 Payment Required',
      challenge: data.challenge,
    };
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return { success: true, agents: data.agents || [] };
}

/**
 * 2. Create a cash escrow request via Velo API (/api/v1/cash/request)
 */
async function createCashRequest(amountStroops = '10000000') {
  const { secretHex, secretHashHex } = createSecretAndHash();
  const url = `${VELO_API_URL}/api/v1/cash/request`;

  const headers = { 'Content-Type': 'application/json' };
  if (X_PAYMENT_HEADER) {
    headers['x-payment'] = X_PAYMENT_HEADER;
  }

  const payload = {
    seller: SELLER_ADDRESS,
    buyer: BUYER_ADDRESS,
    amount_stroops: String(amountStroops),
    secret_hash: secretHashHex,
    notification_type: 'none',
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (response.status === 402) {
    const data = await response.json();
    return {
      success: false,
      status: 402,
      error: 'x402 Payment Required',
      challenge: data.challenge,
    };
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    success: true,
    secretHex,
    secretHashHex,
    claimUrl: data.claim_url,
    qrPayload: data.qr_payload,
    instructions: data.instructions,
  };
}

/**
 * Telegram API Helper: Send message to chat
 */
async function sendTelegramMessage(chatId, text, parseMode = 'Markdown') {
  if (!TELEGRAM_BOT_TOKEN) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    }),
  });
}

/**
 * Handle incoming Telegram command or message
 */
async function handleTelegramMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  if (text.startsWith('/start') || text.startsWith('/help')) {
    const helpMsg = `🤖 *Velo Agent Cash Bot*\n\nAvailable commands:\n• \`/agents\` - Find nearby cash providers\n• \`/request\` - Create a cash request and receive a claim URL`;
    await sendTelegramMessage(chatId, helpMsg);
    return;
  }

  if (text.startsWith('/agents')) {
    await sendTelegramMessage(chatId, '🔍 *Querying Velo API for nearby cash providers...*');
    try {
      const res = await fetchCashAgents();
      if (!res.success && res.status === 402) {
        await sendTelegramMessage(
          chatId,
          `⚠️ *Payment Required (x402)*\nAmount: ${res.challenge.amount_usdc} USDC\nPay To: \`${res.challenge.pay_to}\`\nMemo: \`${res.challenge.memo}\``
        );
        return;
      }

      const count = res.agents.length;
      let reply = `📍 *Found ${count} Cash Agent(s):*\n\n`;
      res.agents.forEach((agent, i) => {
        reply += `${i + 1}. *${agent.name}* (Status: ${agent.status})\n   Rate: ${agent.rate} | Dist: ${agent.distance_km ?? 0}km\n`;
      });
      await sendTelegramMessage(chatId, reply);
    } catch (err) {
      await sendTelegramMessage(chatId, `❌ Error fetching agents: ${err.message}`);
    }
    return;
  }

  if (text.startsWith('/request')) {
    await sendTelegramMessage(chatId, '💸 *Creating cash request on Velo escrow...*');
    try {
      const res = await createCashRequest();
      if (!res.success && res.status === 402) {
        await sendTelegramMessage(
          chatId,
          `⚠️ *Payment Required (x402)*\nAmount: ${res.challenge.amount_usdc} USDC\nPay To: \`${res.challenge.pay_to}\`\nMemo: \`${res.challenge.memo}\``
        );
        return;
      }

      const reply =
        `✅ *Cash Escrow Request Created!*\n\n` +
        `🔗 *Claim URL:* ${res.claimUrl}\n` +
        `📱 *QR Payload:* \`${res.qrPayload}\` \n\n` +
        `ℹ️ _Share this claim link with your cash provider to scan and receive funds._`;

      await sendTelegramMessage(chatId, reply);
    } catch (err) {
      await sendTelegramMessage(chatId, `❌ Error creating cash request: ${err.message}`);
    }
    return;
  }
}

/**
 * Long-polling loop for Telegram Bot updates
 */
async function startTelegramPolling() {
  console.log('🤖 Starting Velo Telegram Bot long-polling...');
  let offset = 0;

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=10`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message) {
            await handleTelegramMessage(update.message);
          }
        }
      }
    } catch (err) {
      console.error('Polling error:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

/**
 * Runnable terminal simulation mode for local testing without Telegram Token
 */
async function runSimulation() {
  console.log('============ VELO TELEGRAM BOT EXAMPLE (SIMULATION MODE) ============');
  console.log(`Target API: ${VELO_API_URL}`);
  console.log(`Seller Addr: ${SELLER_ADDRESS}`);
  console.log(`Buyer Addr:  ${BUYER_ADDRESS}\n`);

  console.log('👉 1. Simulating command: /agents');
  try {
    const agentsRes = await fetchCashAgents();
    if (!agentsRes.success && agentsRes.status === 402) {
      console.log('⚠️ Received x402 Payment Challenge:', agentsRes.challenge);
    } else {
      console.log(`✅ Successfully queried cash agents (${agentsRes.agents.length} found):`);
      console.log(JSON.stringify(agentsRes.agents, null, 2));
    }
  } catch (err) {
    console.log(`⚠️ Agent lookup attempt: ${err.message}`);
  }

  console.log('\n👉 2. Simulating command: /request');
  try {
    const reqRes = await createCashRequest('10000000');
    if (!reqRes.success && reqRes.status === 402) {
      console.log('⚠️ Received x402 Payment Challenge:', reqRes.challenge);
    } else {
      console.log('✅ Successfully created cash request!');
      console.log(`🔗 CLAIM URL: ${reqRes.claimUrl}`);
      console.log(`📱 QR PAYLOAD: ${reqRes.qrPayload}`);
      console.log(`ℹ️ INSTRUCTIONS: ${reqRes.instructions}`);
    }
  } catch (err) {
    console.log(`⚠️ Cash request creation attempt: ${err.message}`);
  }
  console.log('=====================================================================');
}

// Main execution switch
if (process.argv.includes('--test') || !TELEGRAM_BOT_TOKEN) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('Note: TELEGRAM_BOT_TOKEN not set. Running in terminal simulation mode.');
    console.log('To connect to a real Telegram bot, set TELEGRAM_BOT_TOKEN in your environment.\n');
  }
  runSimulation();
} else {
  startTelegramPolling();
}
