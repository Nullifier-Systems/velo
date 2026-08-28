import { describe, expect, it } from "vitest";
import {
  MultisigEscrowStore,
  MultisigReleaseNotFoundError,
} from "../../apps/api/src/lib/multisigEscrowStore.js";

/**
 * Multi-Sig Escrow Threshold Release stress test (issue #433).
 *
 * `release_escrow` must fire exactly once no matter how many signers race
 * to submit the final approval that meets threshold — a double-submit
 * would mean two `release_escrow` calls racing on-chain (the contract's
 * own nonce check stops a literal double-payout, but the API should never
 * even attempt a second submission, since the first already paid the
 * seller and the second would just burn a transaction on a guaranteed
 * `NonceAlreadyUsed` failure).
 *
 * Mirrors this repo's other concurrency stress tests
 * (tests/concurrency/session_key_rotation_stress.test.ts,
 * tests/concurrency/flash_loan_stress.test.ts): race `Promise.all` calls
 * against the store directly and assert on its invariants, rather than
 * timing anything wall-clock-dependent.
 */
describe("multisig escrow threshold release vs. concurrent approvals", () => {
  const TRADE_ID = "a".repeat(64);
  const RECIPIENT = "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const SIGNERS = Array.from({ length: 5 }, (_, i) => ({
    address: `GSIGNER${i}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`.slice(0, 56),
    pubkeyHex: `${i}`.repeat(64).slice(0, 64),
    signature: `${i}`.repeat(128).slice(0, 128),
  }));

  async function makeReadyStore(threshold: number) {
    const store = new MultisigEscrowStore();
    await store.getOrCreateRelease({
      tradeId: TRADE_ID,
      recipientAddress: RECIPIENT,
      releaseAmountStroops: "500",
      threshold,
    });
    return store;
  }

  it("exactly one concurrent approval claims the release once threshold (2-of-5) is met", async () => {
    const store = await makeReadyStore(2);

    const outcomes = await Promise.all(
      SIGNERS.map((signer) =>
        store.addApproval({
          tradeId: TRADE_ID,
          signerAddress: signer.address,
          signerPubkeyHex: signer.pubkeyHex,
          signature: signer.signature,
        }),
      ),
    );

    const claims = outcomes.filter((o) => o.claimedForSubmission);
    expect(claims).toHaveLength(1);

    // Every recorded approval is a distinct signer — no duplicates crept in.
    const finalApprovals = await store.listApprovals(TRADE_ID);
    const distinctSigners = new Set(finalApprovals.map((a) => a.signerAddress));
    expect(distinctSigners.size).toBe(finalApprovals.length);
    expect(finalApprovals.length).toBe(SIGNERS.length);

    const release = await store.getRelease(TRADE_ID);
    expect(release?.status).toBe("releasing");
  });

  it("the same signer approving twice concurrently is recorded once and never double-claims alone", async () => {
    const store = await makeReadyStore(2);
    const [signer] = SIGNERS;

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.addApproval({
          tradeId: TRADE_ID,
          signerAddress: signer.address,
          signerPubkeyHex: signer.pubkeyHex,
          signature: signer.signature,
        }),
      ),
    );

    expect(outcomes.every((o) => !o.claimedForSubmission)).toBe(true);
    const approvals = await store.listApprovals(TRADE_ID);
    expect(approvals).toHaveLength(1);
    expect((await store.getRelease(TRADE_ID))?.status).toBe("pending");
  });

  it("a claimed release cannot be re-claimed once markReleased settles it, even under a fresh burst", async () => {
    const store = await makeReadyStore(2);

    const first = await Promise.all(
      SIGNERS.slice(0, 3).map((signer) =>
        store.addApproval({
          tradeId: TRADE_ID,
          signerAddress: signer.address,
          signerPubkeyHex: signer.pubkeyHex,
          signature: signer.signature,
        }),
      ),
    );
    expect(first.filter((o) => o.claimedForSubmission)).toHaveLength(1);
    await store.markReleased(TRADE_ID, "deadbeef");

    // The remaining signers approving after settlement must never re-claim.
    const late = await Promise.all(
      SIGNERS.slice(3).map((signer) =>
        store.addApproval({
          tradeId: TRADE_ID,
          signerAddress: signer.address,
          signerPubkeyHex: signer.pubkeyHex,
          signature: signer.signature,
        }),
      ),
    );
    expect(late.every((o) => !o.claimedForSubmission)).toBe(true);
    expect((await store.getRelease(TRADE_ID))?.status).toBe("released");
    expect((await store.getRelease(TRADE_ID))?.releaseTxHash).toBe("deadbeef");
  });

  it("markFailed reopens a claimed-but-failed release for a fresh claim burst", async () => {
    const store = await makeReadyStore(2);

    const first = await Promise.all(
      SIGNERS.slice(0, 2).map((signer) =>
        store.addApproval({
          tradeId: TRADE_ID,
          signerAddress: signer.address,
          signerPubkeyHex: signer.pubkeyHex,
          signature: signer.signature,
        }),
      ),
    );
    expect(first.filter((o) => o.claimedForSubmission)).toHaveLength(1);

    // On-chain submission failed — revert to pending so it can be retried.
    await store.markFailed(TRADE_ID);
    expect((await store.getRelease(TRADE_ID))?.status).toBe("pending");

    // A third signer approving now should re-trigger exactly one claim
    // (the two existing approvals already meet threshold).
    const retry = await store.addApproval({
      tradeId: TRADE_ID,
      signerAddress: SIGNERS[2].address,
      signerPubkeyHex: SIGNERS[2].pubkeyHex,
      signature: SIGNERS[2].signature,
    });
    expect(retry.claimedForSubmission).toBe(true);
  });

  it("throws MultisigReleaseNotFoundError for a trade with no pinned release attempt", async () => {
    const store = new MultisigEscrowStore();
    await expect(
      store.addApproval({
        tradeId: "unregistered-trade",
        signerAddress: SIGNERS[0].address,
        signerPubkeyHex: SIGNERS[0].pubkeyHex,
        signature: SIGNERS[0].signature,
      }),
    ).rejects.toBeInstanceOf(MultisigReleaseNotFoundError);
  });
});
