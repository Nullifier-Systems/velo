/**
 * Last-Writer-Wins Register CRDT for chat message synchronization (#305).
 *
 * Uses Lamport clocks for ordering. When two messages have the same
 * clock value, the higher clientId wins (UUID comparison). This ensures
 * convergence without central coordination.
 */

import type { StoredMessage } from "./store";

/* ------------------------------------------------------------------ */
/*  Lamport clock                                                      */
/* ------------------------------------------------------------------ */

let localClock = 0;

/** Get the current Lamport clock value and increment. */
export function tickClock(): number {
  localClock += 1;
  return localClock;
}

/** Merge two clock values by taking the max. */
export function mergeClock(incoming: number): void {
  localClock = Math.max(localClock, incoming);
}

/* ------------------------------------------------------------------ */
/*  Message comparison (LWW)                                           */
/* ------------------------------------------------------------------ */

/**
 * Compare two CRDT messages to determine which wins.
 * Returns > 0 if `a` wins, < 0 if `b` wins, 0 if equal.
 *
 * Rule: higher clock → wins
 * Tiebreak: higher clientId (lexicographic) → wins
 */
export function compareMessages(a: StoredMessage, b: StoredMessage): number {
  if (a.clock !== b.clock) return a.clock - b.clock;
  if (a.clientId !== b.clientId) return a.clientId.localeCompare(b.clientId);
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Merge                                                              */
/* ------------------------------------------------------------------ */

/**
 * Merge a set of locally-stored messages with incoming (remote) messages.
 * Messages with the same `messageId` are resolved via LWW comparison.
 * Returns the merged array sorted by clock ascending.
 */
export function mergeMessages(
  local: StoredMessage[],
  remote: StoredMessage[],
): StoredMessage[] {
  const merged = new Map<string, StoredMessage>();

  // Index local messages
  for (const msg of local) {
    const key = `${msg.tradeId}:${msg.messageId}`;
    merged.set(key, msg);
  }

  // Merge incoming messages — LWW wins
  for (const msg of remote) {
    const key = `${msg.tradeId}:${msg.messageId}`;
    const existing = merged.get(key);
    if (!existing || compareMessages(msg, existing) > 0) {
      merged.set(key, msg);
    }
  }

  const result = Array.from(merged.values());
  result.sort((a, b) => a.clock - b.clock);
  return result;
}

/**
 * Create a new CRDT message with the current Lamport clock.
 */
export function createMessage(
  tradeId: string,
  messageId: string,
  sender: string,
  ciphertext: string,
  nonce: string,
  clientId: string,
): StoredMessage {
  return {
    tradeId,
    messageId,
    sender,
    ciphertext,
    nonce,
    clock: tickClock(),
    clientId,
    timestamp: new Date().toISOString(),
    status: "pending",
  };
}

/**
 * Reset the local clock (for testing).
 */
export function resetClock(): void {
  localClock = 0;
}
