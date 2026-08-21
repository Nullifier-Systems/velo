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
