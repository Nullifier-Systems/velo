import { describe, expect, it } from "vitest";
import {
  MemorySessionKeyRegistryStore,
  type ReserveSpendResult,
} from "../../apps/api/src/lib/session-registry-store.js";

const SESSION_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SPEND_STROOPS = 1_000n;
const SPENDS = 50;
/** The rotation is fired mid-flight so half the spends race ahead of it. */
const ROTATION_AT = 25;

/**
 * Manual stress test (not part of the default turbo suite):
 *   npx vitest run tests/concurrency/session_key_rotation_stress.test.ts
 *
 * Races 50 concurrent `reserveSpend` calls against one `beginRotation` on the
 * same session key. The registry serializes every critical section per key, so
 * each result carries the ordinal of the section that served it; the rotation
 * records its own ordinal when the lock lands. Nothing here depends on
 * wall-clock timing: every spend that ran after the lock must have been
 * refused, so the post-lock success count must be exactly 0.
 */
describe("session key rotation vs. concurrent spends", () => {
  it("lets zero spends through after the rotation lock is acquired", async () => {
    const lockEvents: number[] = [];
    const store = new MemorySessionKeyRegistryStore({
      onLocked: (sequence, key) => {
        lockEvents.push(sequence);
        // The row already reads ROTATING inside the lock.
        expect(key.status).toBe("ROTATING");
      },
    });
    await store.registerKey({
      pubkey: SESSION_KEY,
      // Quota is never the limiter — only the rotation may refuse a spend.
      spendingQuota: SPEND_STROOPS * BigInt(SPENDS) * 2n,
    });

    const operations: Array<Promise<ReserveSpendResult | "rotated">> = [];
    for (let i = 0; i < SPENDS; i += 1) {
      if (i === ROTATION_AT) {
        operations.push(
          store
            .beginRotation(SESSION_KEY, async (tx) => {
              // Hold the lock across awaits, exactly as the route does.
              await Promise.resolve();
              return tx.createProposal({
                oldPubkey: SESSION_KEY,
                newPubkey: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                signer1: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
              });
            })
            .then((outcome) => {
              expect(outcome.ok).toBe(true);
              return "rotated" as const;
            }),
        );
      }
      operations.push(store.reserveSpend(SESSION_KEY, SPEND_STROOPS));
    }

    const settled = await Promise.all(operations);
    const spends = settled.filter((item): item is ReserveSpendResult => item !== "rotated");

    expect(lockEvents).toHaveLength(1);
    const lockSequence = lockEvents[0];
    expect(store.rotationLockSequence).toBe(lockSequence);

    const postLockSuccesses = spends.filter(
      (result) => result.ok && (result.sequence ?? 0) > lockSequence,
    );
    expect(postLockSuccesses).toHaveLength(0);

    // The spends that did land after the lock were refused for the right reason.
    const postLock = spends.filter((result) => (result.sequence ?? 0) > lockSequence);
    expect(postLock).toHaveLength(SPENDS - ROTATION_AT);
    for (const result of postLock) {
      expect(result.reason).toBe("NOT_ACTIVE");
      expect(result.status).toBe("ROTATING");
    }

    // Everything before the lock committed, and the counter matches exactly.
    const preLockSuccesses = spends.filter((result) => result.ok);
    expect(preLockSuccesses).toHaveLength(ROTATION_AT);
    const key = await store.getKey(SESSION_KEY);
    expect(key?.status).toBe("ROTATING");
    expect(key?.spentQuota).toBe(SPEND_STROOPS * BigInt(ROTATION_AT));

    // Once revoked, no further spend is accepted either.
    await store.markRevoked(SESSION_KEY);
    const afterRevoke = await Promise.all(
      Array.from({ length: 10 }, () => store.reserveSpend(SESSION_KEY, SPEND_STROOPS)),
    );
    expect(afterRevoke.filter((result) => result.ok)).toHaveLength(0);
    expect((await store.getKey(SESSION_KEY))?.spentQuota).toBe(
      SPEND_STROOPS * BigInt(ROTATION_AT),
    );
  }, 30_000);
});
