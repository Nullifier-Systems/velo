/**
 * Vector clock for total ordering of state channel commits.
 * Ensures causality: sequence numbers must strictly increment.
 */

export interface VectorClock {
  channelId: string;
  lastSequence: bigint;
  lastSigner: string;
}

/**
 * Validates that a new sequence is strictly greater than the last seen.
 * Returns true if valid, false if stale or replayed.
 */
export function isValidVectorClockAdvance(
  clock: VectorClock,
  newSequence: bigint,
  newSigner: string,
  channelId: string,
): boolean {
  if (channelId !== clock.channelId) {
    return false;
  }
  // Sequence must strictly increase from any party.
  if (newSequence <= clock.lastSequence) {
    return false;
  }
  return true;
}

/**
 * Advances the vector clock to a new sequence, tracking the signer.
 */
export function advanceVectorClock(
  clock: VectorClock,
  newSequence: bigint,
  newSigner: string,
): VectorClock {
  return {
    ...clock,
    lastSequence: newSequence,
    lastSigner: newSigner,
  };
}

/**
 * Creates a fresh vector clock for a new channel.
 */
export function createVectorClock(channelId: string): VectorClock {
  return {
    channelId,
    lastSequence: 0n,
    lastSigner: "",
  };
}

/* ------------------------------------------------------------------ */
/*  Legacy Chat Vector Clock Functions (for chat stream ordering)     */
/* ------------------------------------------------------------------ */

/**
 * Legacy: Increment vector clock for chat messages (per-participant tracking).
 * Returns a new clock with sender's component incremented.
 */
export function incrementClock(
  clock: Record<string, number>,
  sender: string,
): Record<string, number> {
  return {
    ...clock,
    [sender]: (clock[sender] ?? 0) + 1,
  };
}

/**
 * Legacy: Compare two vector clocks for causal ordering.
 * Returns: -1 if a < b, 0 if concurrent, 1 if a > b
 */
export function compareClocks(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aGreater = false;
  let bGreater = false;

  for (const key of allKeys) {
    const aVal = a[key] ?? 0;
    const bVal = b[key] ?? 0;
    if (aVal > bVal) aGreater = true;
    if (bVal > aVal) bGreater = true;
  }

  if (aGreater && !bGreater) return 1;
  if (bGreater && !aGreater) return -1;
  return 0;
}
