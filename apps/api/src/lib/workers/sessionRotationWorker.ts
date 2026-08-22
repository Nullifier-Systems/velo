import {
  SESSION_ROTATION_DLQ,
  SESSION_ROTATION_GROUP,
  SESSION_ROTATION_QUEUE,
} from "@velo/shared";
import type { SessionKeyRegistryStore } from "../session-registry-store.js";
import { getRotationProposal } from "../stellar.js";

/**
 * Confirms session-key rotations on-chain and retires the old key (#375).
 *
 * The route replies 202 as soon as the proposal is durable; this worker drains
 * `velo:session-rotation-queue` and only marks the key REVOKED once the
 * contract reports the proposal `executed` (the queryable effect of the
 * `session_key_rotated` event). Unconfirmed proposals are retried up to
 * `maxAttempts` times with exponential backoff + jitter, then dead-lettered to
 * `velo:session-rotation-dlq` for an operator.
 */

export interface SessionRotationMessage {
  proposalId: string;
  oldSessionPubkey: string;
  newSessionPubkey: string;
  /** On-chain u64 proposal id, once the approval reached the contract. */
  onchainProposalId?: string;
}

export type SessionRotationWorkerEvent =
  | { type: "confirmed"; proposalId: string; attempts: number }
  | { type: "retry"; proposalId: string; attempt: number; reason: string }
  | { type: "dead-letter"; proposalId: string; reason: string };

/** Structural subset of the redis client this worker needs. */
export interface RotationQueueClient {
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

export interface SessionRotationWorkerOptions {
  store: SessionKeyRegistryStore;
  /** Redis mode. Omit to drain the in-memory `queue` array instead. */
  redis?: RotationQueueClient;
  /** In-memory queue used when no redis client is injected (dev / tests). */
  queue?: SessionRotationMessage[];
  /** In-memory dead-letter sink used when no redis client is injected. */
  dlq?: SessionRotationMessage[];
  pollIntervalMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  consumerName?: string;
  /** Resolves true once the rotation is executed on-chain. */
  confirmRotation?: (message: SessionRotationMessage) => Promise<boolean>;
  onEvent?: (event: SessionRotationWorkerEvent) => void;
  /** Injectable jitter source; defaults to Math.random. */
  random?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Default confirmation: the contract reports the proposal as executed. */
async function confirmOnChain(message: SessionRotationMessage): Promise<boolean> {
  const contractId = process.env.SESSION_ACCOUNT_CONTRACT_ID ?? "";
  if (!contractId || !message.onchainProposalId) return false;
  const proposal = await getRotationProposal(contractId, message.onchainProposalId);
  return Boolean(proposal?.executed);
}

function toMessage(fields: Record<string, string>): SessionRotationMessage | null {
  if (!fields.proposalId || !fields.oldSessionPubkey || !fields.newSessionPubkey) return null;
  return {
    proposalId: fields.proposalId,
    oldSessionPubkey: fields.oldSessionPubkey,
    newSessionPubkey: fields.newSessionPubkey,
    onchainProposalId: fields.onchainProposalId,
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

export function startSessionRotationWorker(
  options: SessionRotationWorkerOptions,
): () => void {
  const {
    store,
    redis,
    queue = [],
    dlq,
    pollIntervalMs = 1_000,
    maxAttempts = 5,
    baseDelayMs = 1_000,
    consumerName = `rotation-${process.pid}`,
    confirmRotation = confirmOnChain,
    onEvent,
    random = Math.random,
  } = options;

  let stopped = false;
  let ticking = false;
  let groupReady = !redis;

  async function deadLetter(message: SessionRotationMessage, reason: string): Promise<void> {
    if (redis) {
      await redis
        .xAdd(SESSION_ROTATION_DLQ, "*", {
          proposalId: message.proposalId,
          oldSessionPubkey: message.oldSessionPubkey,
          newSessionPubkey: message.newSessionPubkey,
          reason,
        })
        .catch(() => undefined);
    } else {
      dlq?.push(message);
    }
    onEvent?.({ type: "dead-letter", proposalId: message.proposalId, reason });
  }

  async function handleMessage(message: SessionRotationMessage): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let reason: string;
      try {
        if (await confirmRotation(message)) {
          await store.markRevoked(message.oldSessionPubkey);
          await store.markProposalExecuted(message.proposalId);
          onEvent?.({
            type: "confirmed",
            proposalId: message.proposalId,
            attempts: attempt + 1,
          });
          return;
        }
        reason = "rotation not executed on-chain yet";
      } catch (error) {
        reason = String(error);
      }

      onEvent?.({
        type: "retry",
        proposalId: message.proposalId,
        attempt: attempt + 1,
        reason,
      });
      if (attempt + 1 >= maxAttempts) {
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
          await handleMessage(queue.shift() as SessionRotationMessage);
        }
        return;
      }
      if (!groupReady) {
        await redis
          .xGroupCreate(SESSION_ROTATION_QUEUE, SESSION_ROTATION_GROUP, "0", { MKSTREAM: true })
          .catch(() => undefined);
        groupReady = true;
      }
      const response = await redis.xReadGroup(
        SESSION_ROTATION_GROUP,
        consumerName,
        [{ key: SESSION_ROTATION_QUEUE, id: ">" }],
        { COUNT: 10 },
      );
      for (const entry of readEntries(response)) {
        const message = toMessage(entry.message);
        if (message) await handleMessage(message);
        await redis.xAck(SESSION_ROTATION_QUEUE, SESSION_ROTATION_GROUP, entry.id);
      }
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    void tick().catch(() => undefined);
  }, pollIntervalMs);
  // Never keep the process alive just for the rotation drain loop.
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
