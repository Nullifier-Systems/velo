import { createClient } from "redis";
import { pgPool } from "../../app.js";
import { getLatestLedgerSequence, refundEscrow } from "../stellar.js";
import { getCashRequest } from "../store.js";
import { sendRefundCountdownAlert } from "../webhook.js";

const QUEUE_NAME = "velo:tranche-refund-queue";
const GROUP_NAME = "tranche-refund-group";
const DLQ_NAME = "velo:tranche-refund-dlq";
const POLL_INTERVAL_MS = 5000;
const MAX_ATTEMPTS = 5;

export async function startTrancheRefundWorker() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const redis = createClient({ url: redisUrl });
  
  await redis.connect();

  try {
    await redis.xGroupCreate(QUEUE_NAME, GROUP_NAME, "0", { MKSTREAM: true });
  } catch (err: any) {
    if (!err.message.includes("BUSYGROUP")) {
      console.error("Error creating redis group", err);
    }
  }

  let stopped = false;
  let ticking = false;

  async function checkExpiringLedgers() {
    if (!pgPool) return;
    try {
      const currentLedger = await getLatestLedgerSequence();
      
      const client = await pgPool.connect();
      try {
        await client.query("BEGIN");
        
        // Find pending schedules that need warnings
        const warningRes = await client.query(
          `SELECT trade_id, unreleased_tranches, unreleased_amount, timeout_ledger_sequence
           FROM tranche_refund_schedules
           WHERE status = 'PENDING' AND timeout_ledger_sequence - $1 <= 100
           FOR UPDATE SKIP LOCKED`,
          [currentLedger]
        );

        for (const row of warningRes.rows) {
          const trade = getCashRequest(row.trade_id);
          if (trade) {
             const estimatedSeconds = Math.max(0, row.timeout_ledger_sequence - currentLedger) * 6;
             await sendRefundCountdownAlert({
               tradeId: row.trade_id,
               amountStroops: row.unreleased_amount.toString(),
               buyer: trade.buyer,
               seller: trade.seller,
               timeoutLedger: row.timeout_ledger_sequence,
               latestLedger: currentLedger,
               ledgersUntilRefund: Math.max(0, row.timeout_ledger_sequence - currentLedger),
               estimatedSecondsUntilRefund: estimatedSeconds
             });
          }
          await client.query(`UPDATE tranche_refund_schedules SET status = 'WARNING_SENT' WHERE trade_id = $1`, [row.trade_id]);
        }
        
        // Find schedules that reached timeout but haven't been queued yet
        // For simplicity, we assume they get moved to REFUND_EXECUTED by the manual trigger or the worker itself.
        // The automated fallback execution worker triggers refundEscrow() for remaining unreleased tranches when thresholds are reached.
        const executeRes = await client.query(
          `SELECT trade_id
           FROM tranche_refund_schedules
           WHERE (status = 'PENDING' OR status = 'WARNING_SENT') AND $1 > timeout_ledger_sequence
           FOR UPDATE SKIP LOCKED`,
          [currentLedger]
        );

        for (const row of executeRes.rows) {
           await redis.xAdd(QUEUE_NAME, "*", { tradeId: row.trade_id });
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("Error checking expiring ledgers", err);
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("Error fetching latest ledger", err);
    }
  }

  async function processQueue() {
    try {
      const response = await redis.xReadGroup(
        GROUP_NAME,
        `consumer-${process.pid}`,
        [{ key: QUEUE_NAME, id: ">" }],
        { COUNT: 10 }
      );

      if (!response) return;

      for (const stream of response as any[]) {
        for (const entry of stream.messages) {
          const { tradeId } = entry.message;
          let success = false;
          
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
             try {
                // Perform the on-chain refund. In a real app we need the trade details.
                const trade = getCashRequest(tradeId);
                if (trade) {
                   await refundEscrow(trade.contractId, tradeId, trade.seller, trade.buyer, trade.amountStroops);
                }
                
                // Update DB via the trigger route logic (or directly here if it was automated).
                // If it was already set to REFUND_EXECUTED by the route, we just execute on-chain.
                if (pgPool) {
                   await pgPool.query(`UPDATE tranche_refund_schedules SET status = 'REFUND_EXECUTED' WHERE trade_id = $1`, [tradeId]);
                }
                
                success = true;
                break;
             } catch (err) {
                console.error(`Refund failed for trade ${tradeId}, attempt ${attempt}`, err);
                await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
             }
          }

          if (success) {
            await redis.xAck(QUEUE_NAME, GROUP_NAME, entry.id);
          } else {
            await redis.xAdd(DLQ_NAME, "*", { tradeId, reason: "Max attempts reached" });
            await redis.xAck(QUEUE_NAME, GROUP_NAME, entry.id);
          }
        }
      }
    } catch (err) {
      console.error("Error processing refund queue", err);
    }
  }

  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await checkExpiringLedgers();
      await processQueue();
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await redis.quit();
  };
}
