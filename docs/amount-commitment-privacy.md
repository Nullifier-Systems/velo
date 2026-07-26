# Confidential trade amounts via a commitment scheme (#276)

This document describes the client-side amount-commitment primitive added in
`apps/api/src/lib/amount-commitment.ts`, how it is meant to plug into the escrow
`lock()` / `release()` flow, and -- most importantly -- an honest account of
exactly what it does and does not hide.

## Problem

Today `TradeState.amount` is a plain `i128`. It is passed to `lock()` in the
clear, stored in a publicly-readable field, and emitted in the `locked` /
`released` events. Anyone reading the ledger learns every trade's exact amount.

## Approach: hash commitment + reveal-and-prove at settlement

This slice implements the **revealed-amount-plus-proof-of-consistency** approach
explicitly allowed by the issue, not a homomorphic (Pedersen) scheme.

At `lock()` time the client:

1. picks the trade `amount` and a random 32-byte blinding factor,
2. computes `commitment = SHA-256(DOMAIN || amount_be128 || blinding)`,
3. sends only `commitment` on-chain -- never the plaintext amount.

At `release()` time the client reveals a **witness** `{ amount, blinding, fee,
payout }`. Any verifier (the contract, or a reviewer) can:

- re-hash `amount` + `blinding` and check it equals the stored `commitment`
  (binding: you cannot open a commitment to any amount other than the one you
  committed to), and
- recompute `fee = amount * fee_bps / 10000` and `payout = amount - fee` with
  the same integer truncation Soroban uses, and confirm they match the witness.

A witness that claims a different amount, or a doctored fee/payout, fails
verification -- this is the "release with a proof for a different amount must
fail" acceptance criterion.

## API
import {
commitAmount,
buildReleaseWitness,
verifyReleaseWitness,
} from "./lib/amount-commitment.js";
// before lock():
const commitment = commitAmount(amountStroops);
// -> { commitmentHex, blindingHex, amountStroops }
// publish commitment.commitmentHex on-chain; keep blindingHex secret.
// at release():
const witness = buildReleaseWitness(commitment, platformFeeBps);
const ok = verifyReleaseWitness(commitment.commitmentHex, witness, platformFeeBps);

`deriveFeeSplit(amount, feeBps)` is exported separately so the backend can
compute the exact fee/payout the contract will apply, off-chain, from the
committed amount.

## What this actually hides -- and what it does not

**Hidden**

- The plaintext amount at `lock()` time. Only a 32-byte hash is published; with
  a uniformly random blinding factor the commitment is computationally hiding.

**NOT hidden -- read this before assuming any privacy**

- **Settlement transfers leak the amount.** `release()` (and `refund()`,
  `resolve_dispute()`, `batch_release()`) call `token::transfer`, and the
  SEP-41 token contract emits its own `transfer` event with the amount in the
  clear. Anyone watching the token contract still sees exactly how much moved.
  This commitment hides the amount in the escrow contract's own state and
  events, not in the token layer underneath it.
- **The revealed witness is public at release.** The proof-of-consistency
  approach reveals the amount to whoever verifies the release. This buys
  amount-privacy until settlement, not forever.
- **No range proof.** A hash commitment says nothing about the size of the
  committed value. Enforcing "amount > 0 and within bounds" still requires the
  plaintext at some point (today, at reveal).
- **Not homomorphic.** Unlike a Pedersen commitment, the contract cannot do fee
  arithmetic on the commitment alone; it needs the revealed amount. That is why
  this is a reveal-at-settlement design, not on-chain confidential math.
- Buyer/seller identity, timing, and linkability are explicitly out of scope.

A privacy feature that overclaims is worse than none: this primitive narrows
where the amount is exposed (out of the escrow contract's state, into the
unavoidable token-transfer event at settlement). It does not make trades
confidential end-to-end.

## Wiring it in (follow-up, not included in this slice)

To adopt this in the contract, `lock()` would store `commitment: BytesN<32>`
instead of (or alongside) `amount`, and `release()` would take the witness,
verify it against the stored commitment, and derive the transfer amounts from
the revealed value. `apps/api/src/lib/stellar.ts` would call `commitAmount`
before building the `lock` transaction and pass the witness into `release`.
Those cross-cutting changes to the live settlement path are intentionally left
out here so the primitive and its honest threat model can land and be reviewed
on their own.

## Tests

`apps/api/src/lib/amount-commitment.test.ts` covers hiding, binding,
correct and incorrect openings, the contract-matching fee math (including
truncation toward zero), and honest vs. tampered release-witness verification.