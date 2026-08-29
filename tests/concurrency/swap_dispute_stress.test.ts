import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  SwapDisputeStore,
  InvalidPreimageError,
  SwapDisputeNotFoundError,
} from "../../apps/api/src/lib/swapDisputeStore.js";

/**
 * Atomic swap dispute bridge stress test.
 *
 * The invariant: for any one swap, **at most one** refund is ever claimed and
 * **at most one** caller owns the extracted secret — no matter how many
 * workers, retries, and operator API calls race on the same swap in the same
 * moment. A duplicate refund claim would mean two `refund()` submissions
 * racing on-chain; the contract's own status check stops a literal
 * double-payout, but the API should never attempt the second, since it is a
 * guaranteed-failed transaction against a leg that has already paid out.
 *
 * Mirrors this repo's other concurrency stress tests
 * (tests/concurrency/multisig_release_stress.test.ts,
 * tests/concurrency/flash_loan_stress.test.ts): race `Promise.all` against the
 * store and assert on its invariants, rather than timing anything
 * wall-clock-dependent.
 */
describe("atomic swap dispute bridge vs. concurrent claims", () => {
  const SWAP_ID = "a".repeat(64);
  const INITIATOR = `GINITIATOR${"X".repeat(46)}`.slice(0, 56);
  const COUNTERPARTY = `GCOUNTERPARTY${"X".repeat(43)}`.slice(0, 56);
  const EXPIRATION_LEDGER = 1_000;

  const PREIMAGE = "11".repeat(32);
  const SECRET_HASH = createHash("sha256")
    .update(Buffer.from(PREIMAGE, "hex"))
    .digest("hex");

  async function makeStore(overrides: { expirationLedger?: number } = {}) {
    const store = new SwapDisputeStore();
    await store.registerSwap({
      swapId: SWAP_ID,
      initiatorAddress: INITIATOR,
      counterpartyAddress: COUNTERPARTY,
      secretHash: SECRET_HASH,
      expirationLedger: overrides.expirationLedger ?? EXPIRATION_LEDGER,
    });
    return store;
  }

  // ── Refund claims ────────────────────────────────────────────────────────

  it("exactly one of 50 concurrent refund claims succeeds", async () => {
    const store = await makeStore();
    const afterExpiry = EXPIRATION_LEDGER + 1;

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => store.claimRefund(SWAP_ID, afterExpiry)),
    );

    const winners = outcomes.filter((o) => o.claimedForRefund);
    expect(winners).toHaveLength(1);

    // Every loser is told why, so a caller never silently assumes success.
    const losers = outcomes.filter((o) => !o.claimedForRefund);
    expect(losers).toHaveLength(49);
    expect(losers.every((o) => o.reason === "claimed")).toBe(true);

    const bridge = await store.getBridge(SWAP_ID);
    expect(bridge?.state).toBe("REFUND_CLAIMABLE");
  });

  it("a second wave of claims after the first still yields no extra refunds", async () => {
    const store = await makeStore();
    const afterExpiry = EXPIRATION_LEDGER + 1;

    const first = await Promise.all(
      Array.from({ length: 25 }, () => store.claimRefund(SWAP_ID, afterExpiry)),
    );
    const second = await Promise.all(
      Array.from({ length: 25 }, () => store.claimRefund(SWAP_ID, afterExpiry)),
    );

    const totalWinners = [...first, ...second].filter((o) => o.claimedForRefund);
    expect(totalWinners).toHaveLength(1);
  });

  it("refuses every claim while the swap is still live", async () => {
    const store = await makeStore();
    const beforeExpiry = EXPIRATION_LEDGER - 1;

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => store.claimRefund(SWAP_ID, beforeExpiry)),
    );

    expect(outcomes.every((o) => !o.claimedForRefund)).toBe(true);
    expect(outcomes.every((o) => o.reason === "not_expired")).toBe(true);
    expect((await store.getBridge(SWAP_ID))?.state).toBe("ACTIVE");
  });

  it("claims exactly at the expiration ledger, not one before", async () => {
    const store = await makeStore();

    const early = await store.claimRefund(SWAP_ID, EXPIRATION_LEDGER - 1);
    expect(early.claimedForRefund).toBe(false);

    const onTime = await store.claimRefund(SWAP_ID, EXPIRATION_LEDGER);
    expect(onTime.claimedForRefund).toBe(true);
  });

  // ── Secret extraction ────────────────────────────────────────────────────

  it("exactly one of 50 concurrent secret extractions claims settlement", async () => {
    const store = await makeStore();

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => store.recordSecret(SWAP_ID, PREIMAGE)),
    );

    const winners = outcomes.filter((o) => o.claimedForSettlement);
    expect(winners).toHaveLength(1);

    const bridge = await store.getBridge(SWAP_ID);
    expect(bridge?.state).toBe("SECRET_EXTRACTED");
    expect(bridge?.secretPreimage).toBe(PREIMAGE);
  });

  it("the stored preimage is write-once", async () => {
    const store = await makeStore();
    await store.recordSecret(SWAP_ID, PREIMAGE);

    // A second, differently-hashing preimage is rejected outright...
    const other = "22".repeat(32);
    await expect(store.recordSecret(SWAP_ID, other)).rejects.toBeInstanceOf(
      InvalidPreimageError,
    );

    // ...and the original survives untouched.
    expect((await store.getBridge(SWAP_ID))?.secretPreimage).toBe(PREIMAGE);
  });

  it("rejects a preimage that does not hash to the swap's secret hash", async () => {
    const store = await makeStore();
    await expect(store.recordSecret(SWAP_ID, "33".repeat(32))).rejects.toBeInstanceOf(
      InvalidPreimageError,
    );
    expect((await store.getBridge(SWAP_ID))?.secretPreimage).toBeNull();
  });

  // ── The two paths must never both fire ───────────────────────────────────

  it("an extracted secret makes the swap permanently un-refundable", async () => {
    const store = await makeStore();
    await store.recordSecret(SWAP_ID, PREIMAGE);

    // Well past expiry, a refund must still be refused: the counterparty holds
    // a usable preimage, so returning the funds would let them take both legs.
    const claim = await store.claimRefund(SWAP_ID, EXPIRATION_LEDGER + 10_000);
    expect(claim.claimedForRefund).toBe(false);
    expect(claim.reason).toBe("secret_already_extracted");
  });

  it("secret extraction and refund claims racing together resolve to one outcome", async () => {
    const store = await makeStore();
    const afterExpiry = EXPIRATION_LEDGER + 1;

    // 25 workers see a reveal at the same instant 25 others see an expiry.
    const outcomes = await Promise.all([
      ...Array.from({ length: 25 }, () =>
        store.recordSecret(SWAP_ID, PREIMAGE).then(
          (r) => ({ kind: "secret" as const, claimed: r.claimedForSettlement }),
          () => ({ kind: "secret" as const, claimed: false }),
        ),
      ),
      ...Array.from({ length: 25 }, () =>
        store.claimRefund(SWAP_ID, afterExpiry).then(
          (r) => ({ kind: "refund" as const, claimed: r.claimedForRefund }),
          () => ({ kind: "refund" as const, claimed: false }),
        ),
      ),
    ]);

    const claimed = outcomes.filter((o) => o.claimed);

    // Exactly one side wins overall — never a secret extraction *and* a refund
    // for the same swap, which would be the double-spend this bridge exists to
    // prevent.
    expect(claimed).toHaveLength(1);

    const bridge = await store.getBridge(SWAP_ID);
    expect(["SECRET_EXTRACTED", "REFUND_CLAIMABLE"]).toContain(bridge?.state);
  });

  it("a resolved swap accepts no further claims", async () => {
    const store = await makeStore();
    await store.claimRefund(SWAP_ID, EXPIRATION_LEDGER + 1);
    await store.markResolved(SWAP_ID);

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => store.claimRefund(SWAP_ID, EXPIRATION_LEDGER + 1)),
    );
    expect(outcomes.every((o) => !o.claimedForRefund)).toBe(true);
    expect(outcomes.every((o) => o.reason === "resolved")).toBe(true);
  });

  // ── Isolation and error handling ─────────────────────────────────────────

  it("concurrent claims across many swaps stay independent", async () => {
    const store = new SwapDisputeStore();
    const swapIds = Array.from({ length: 20 }, (_, i) => String(i).padStart(64, "0"));

    await Promise.all(
      swapIds.map((swapId) =>
        store.registerSwap({
          swapId,
          initiatorAddress: INITIATOR,
          counterpartyAddress: COUNTERPARTY,
          secretHash: SECRET_HASH,
          expirationLedger: EXPIRATION_LEDGER,
        }),
      ),
    );

    // Five racers per swap, all 20 swaps at once.
    const outcomes = await Promise.all(
      swapIds.flatMap((swapId) =>
        Array.from({ length: 5 }, () =>
          store.claimRefund(swapId, EXPIRATION_LEDGER + 1).then((r) => ({
            swapId,
            claimed: r.claimedForRefund,
          })),
        ),
      ),
    );

    // Exactly one winner per swap — 20 in total, one for each distinct id.
    const winners = outcomes.filter((o) => o.claimed);
    expect(winners).toHaveLength(swapIds.length);
    expect(new Set(winners.map((w) => w.swapId)).size).toBe(swapIds.length);
  });

  it("registering the same swap twice is idempotent under concurrency", async () => {
    const store = new SwapDisputeStore();
    const inputs = {
      swapId: SWAP_ID,
      initiatorAddress: INITIATOR,
      counterpartyAddress: COUNTERPARTY,
      secretHash: SECRET_HASH,
      expirationLedger: EXPIRATION_LEDGER,
    };

    const bridges = await Promise.all(
      Array.from({ length: 10 }, () => store.registerSwap(inputs)),
    );

    expect(bridges.every((b) => b.swapId === SWAP_ID)).toBe(true);
    expect(bridges.every((b) => b.state === "ACTIVE")).toBe(true);
  });

  it("claims against an unknown swap reject rather than inventing a bridge", async () => {
    const store = await makeStore();
    await expect(
      store.claimRefund("f".repeat(64), EXPIRATION_LEDGER + 1),
    ).rejects.toBeInstanceOf(SwapDisputeNotFoundError);
  });

  it("listExpiredActive only returns live, expired swaps", async () => {
    const store = await makeStore();

    expect(await store.listExpiredActive(EXPIRATION_LEDGER - 1)).toHaveLength(0);
    expect(await store.listExpiredActive(EXPIRATION_LEDGER)).toHaveLength(1);

    // Once claimed it leaves the worker's candidate set, so the next tick does
    // not try to claim it again.
    await store.claimRefund(SWAP_ID, EXPIRATION_LEDGER);
    expect(await store.listExpiredActive(EXPIRATION_LEDGER)).toHaveLength(0);
  });
});
