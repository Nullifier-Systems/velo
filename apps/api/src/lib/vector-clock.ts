/**
 * Vector Clock implementation for causal message ordering in distributed chat.
 *
 * A vector clock is a mechanism for tracking partial ordering of events in a distributed system.
 * Each participant maintains a counter that increments on every message sent, and updates all
 * counters based on received messages to establish happened-before relationships.
 *
 * Format: { [participant: string]: number }
 * Example: { buyer: 5, seller: 3, system: 2 }
 *
 * Invariants:
 * 1. A message with clock V1 causally precedes V2 if V1 <= V2 componentwise (not all equal)
 * 2. Two messages with clocks V1 and V2 are concurrent if neither V1 <= V2 nor V2 <= V1
 * 3. All replayed messages must be ordered by their vector clocks
 */

export type VectorClock = Record<string, number>;

/**
 * Increment a participant's counter in the vector clock.
 * Called when that participant sends a message.
 */
export function incrementClock(
  clock: VectorClock,
  participant: string,
): VectorClock {
  return {
    ...clock,
    [participant]: (clock[participant] ?? 0) + 1,
  };
}

/**
 * Merge two vector clocks by taking componentwise maximum.
 * Called when a participant receives a message or joins a room.
 * This ensures the receiver's clock reflects all events it has observed.
 */
export function mergeClock(
  local: VectorClock,
  received: VectorClock,
): VectorClock {
  const merged = { ...local };
  for (const [participant, count] of Object.entries(received)) {
    merged[participant] = Math.max(merged[participant] ?? 0, count);
  }
  return merged;
}

/**
 * Check if clock V1 causally precedes V2 (V1 happened-before V2).
 * V1 <= V2 means all components of V1 are <= corresponding components of V2,
 * with at least one strictly less (not all equal, which would mean V1 == V2).
 */
export function happensBefore(v1: VectorClock, v2: VectorClock): boolean {
  let allLessOrEqual = true;
  let hasStrict = false;

  for (const participant of new Set([...Object.keys(v1), ...Object.keys(v2)])) {
    const c1 = v1[participant] ?? 0;
    const c2 = v2[participant] ?? 0;
    if (c1 > c2) return false; // v1[p] > v2[p] means NOT v1 <= v2
    if (c1 < c2) hasStrict = true;
  }

  return hasStrict; // Must have at least one strict inequality
}

/**
 * Check if two clocks are concurrent (neither causally precedes the other).
 * Identical clocks are NOT concurrent.
 */
export function areConcurrent(v1: VectorClock, v2: VectorClock): boolean {
  // Check if identical first
  const allParticipants = new Set([...Object.keys(v1), ...Object.keys(v2)]);
  let isIdentical = true;
  for (const participant of allParticipants) {
    if (v1[participant] !== v2[participant]) {
      isIdentical = false;
      break;
    }
  }
  if (isIdentical) return false;
  
  return !happensBefore(v1, v2) && !happensBefore(v2, v1);
}

/**
 * Compare two vector clocks for sorting purposes.
 * Returns:
 *   -1 if v1 happens-before v2
 *    1 if v2 happens-before v1
 *    0 if v1 == v2 (identical clocks)
 *   (concurrent clocks are ordered by lexicographic order of their JSON representation)
 */
export function compareClocks(v1: VectorClock, v2: VectorClock): number {
  if (happensBefore(v1, v2)) return -1;
  if (happensBefore(v2, v1)) return 1;

  // Check if identical
  const allParticipants = new Set([...Object.keys(v1), ...Object.keys(v2)]);
  let isIdentical = true;
  for (const p of allParticipants) {
    if ((v1[p] ?? 0) !== (v2[p] ?? 0)) {
      isIdentical = false;
      break;
    }
  }
  if (isIdentical) return 0;

  // Concurrent: use JSON representation for deterministic sorting (needed for cache consistency)
  const json1 = JSON.stringify(v1);
  const json2 = JSON.stringify(v2);
  return json1 < json2 ? -1 : 1;
}

/**
 * Sort vector clocks by happened-before relationship with concurrent ordering by JSON.
 * Useful for replaying messages in a consistent order.
 */
export function sortClocks(clocks: VectorClock[]): VectorClock[] {
  return [...clocks].sort(compareClocks);
}

/**
 * Check if a participant's clock is "ready to receive" given a received clock.
 * Used to prevent out-of-order message delivery: a client should only process
 * a message if it has already processed all causally preceding messages.
 *
 * Rule: A message with clock V can be delivered if V[sender] == local[sender] + 1
 * and V[other] <= local[other] for all other participants.
 */
export function canDeliver(
  local: VectorClock,
  messageAuthor: string,
  messageClock: VectorClock,
): boolean {
  const authorCount = messageClock[messageAuthor] ?? 0;
  const localAuthorCount = local[messageAuthor] ?? 0;

  // Author must have incremented exactly once
  if (authorCount !== localAuthorCount + 1) return false;

  // Other participants must not have incremented ahead
  for (const [participant, count] of Object.entries(messageClock)) {
    if (participant !== messageAuthor && (local[participant] ?? 0) < count) {
      return false; // We haven't seen this participant's message yet
    }
  }

  return true;
}

/**
 * Fill missing vector clock entries for all known participants.
 * Ensures consistent comparison operations even if clocks have different keys.
 */
export function normalizeClock(
  clock: VectorClock,
  knownParticipants: string[],
): VectorClock {
  const normalized: VectorClock = { ...clock };
  for (const participant of knownParticipants) {
    if (!(participant in normalized)) {
      normalized[participant] = 0;
    }
  }
  return normalized;
}

/* ------------------------------------------------------------------ */
/*  Ledger vector clocks (#374)                                       */
/* ------------------------------------------------------------------ */

/**
 * A ledger vector clock tracks per-source last-observed ledger sequences so
 * the indexer can prove it has ingested every causally preceding frame even
 * when the RPC stream delivers them out of order. Format:
 *   { [source: string]: ledgerSequence }
 * e.g. { "rpc-a": 49281901, "rpc-b": 49281899 }.
 */
export type LedgerVectorClock = VectorClock;

/**
 * Merge two ledger vector clocks by taking the componentwise maximum ledger
 * sequence. Called when an out-of-order frame arrives from a source we have
 * already heard from, so we can never regress a source's high-water mark.
 */
export function mergeLedgerClocks(
  local: LedgerVectorClock,
  received: LedgerVectorClock,
): LedgerVectorClock {
  return mergeClock(local, received);
}

/**
 * True when `candidate` may be persisted without risking out-of-order state
 * drift: the frame's own source must be exactly one ledger ahead of our
 * high-water mark for that source, and no other source may have run ahead
 * of the frame's observed positions.
 */
export function canDeliverLedger(
  local: LedgerVectorClock,
  source: string,
  frameClock: LedgerVectorClock,
): boolean {
  const sourceLedger = frameClock[source] ?? 0;
  const localSourceLedger = local[source] ?? 0;
  if (sourceLedger !== localSourceLedger + 1) return false;
  for (const [participant, ledger] of Object.entries(frameClock)) {
    if (participant !== source && (local[participant] ?? 0) < ledger) {
      return false;
    }
  }
  return true;
}

/**
 * Deterministically order out-of-order ledger frames so they are replayed in
 * causal order before persistence. Precedence is: strictly-happens-before
 * (per componentwise comparison), then lower ledger first, then source name
 * as a stable tiebreak.
 */
export function sortLedgerFrames<T>(
  frames: Array<{ source: string; clock: LedgerVectorClock; frame: T }>,
): Array<{ source: string; clock: LedgerVectorClock; frame: T }> {
  return [...frames].sort((a, b) => {
    const before = happensBefore(a.clock, b.clock);
    const after = happensBefore(b.clock, a.clock);
    if (before) return -1;
    if (after) return 1;
    const aMin = ledgerHeight(a.clock);
    const bMin = ledgerHeight(b.clock);
    if (aMin !== bMin) return aMin - bMin;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  });
}

/** The highest ledger sequence observed across all sources in a clock. */
export function ledgerHeight(clock: LedgerVectorClock): number {
  return Math.max(0, ...Object.values(clock).map(Number));
}
