/**
 * Idempotent offline mutation queue (#305).
 *
 * Queues API mutations when offline and replays them in order when
 * connectivity returns. Every operation carries a unique idempotency
 * key so the server can safely deduplicate.
 */

import { enqueueOp, getPendingOps, updateOpStatus, type QueuedOperation } from "./store";

const MAX_RETRIES = 3;

/* ------------------------------------------------------------------ */
/*  Enqueue                                                            */
/* ------------------------------------------------------------------ */

export interface QueueInput {
  endpoint: string;
  method: string;
  body?: unknown;
  idempotencyKey: string;
}

export async function queueMutation(input: QueueInput): Promise<void> {
  await enqueueOp({
    endpoint: input.endpoint,
    method: input.method,
    body: input.body ? JSON.stringify(input.body) : undefined,
    idempotencyKey: input.idempotencyKey,
    status: "pending",
  });
}

/* ------------------------------------------------------------------ */
/*  Flush                                                              */
/* ------------------------------------------------------------------ */

export interface FlushResult {
  succeeded: number;
  failed: number;
  retriable: number;
}

/**
 * Flush all pending operations to the server.
 * Uses x-idempotency-key header for safe retry.
 */
export async function flushQueue(fetchFn: typeof globalThis.fetch, baseUrl: string): Promise<FlushResult> {
  const pending = await getPendingOps();
  let succeeded = 0;
  let failed = 0;
  let retriable = 0;

  for (const op of pending) {
    if (!op.id) continue;
    await updateOpStatus(op.id, "syncing");

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-idempotency-key": op.idempotencyKey,
      };

      const response = await fetchFn(`${baseUrl}${op.endpoint}`, {
        method: op.method,
        headers,
        body: op.body,
      });

      if (response.ok || response.status === 409) {
        // 409 Conflict means the operation already succeeded (idempotent).
        await updateOpStatus(op.id, "done");
        succeeded += 1;
      } else if (response.status >= 400 && response.status < 500) {
        // Client errors other than 409 are permanent failures.
        await updateOpStatus(op.id, "failed");
        failed += 1;
      } else {
        // 5xx or network error — retry if under limit.
        const newCount = op.retryCount + 1;
        if (newCount >= MAX_RETRIES) {
          await updateOpStatus(op.id, "failed");
          failed += 1;
        } else {
          await updateOpStatus(op.id, "pending", newCount);
          retriable += 1;
        }
      }
    } catch {
      // Network error during fetch.
      const newCount = op.retryCount + 1;
      if (newCount >= MAX_RETRIES) {
        await updateOpStatus(op.id, "failed");
        failed += 1;
      } else {
        await updateOpStatus(op.id, "pending", newCount);
        retriable += 1;
      }
    }
  }

  return { succeeded, failed, retriable };
}
