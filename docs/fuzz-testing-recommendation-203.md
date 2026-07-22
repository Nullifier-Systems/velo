## Fuzz Testing Recommendation — Escrow & Atomic-Swap Contracts

### Framework: `proptest`

Fits the existing `#[cfg(test)]` + `soroban-sdk` testutils pattern already in this repo (see `contracts/escrow/src/test.rs`), so no new CI/test infra is needed. Good shrinking support for numeric edge cases (fees, amounts, ledger sequences).

### Six Invariants, Grounded in Code

1. **Conservation of value** — total in must equal total out across any `lock` → `release`/`refund`/`resolve` sequence (`contracts/escrow/src/lib.rs:266-386`, `contracts/atomic-swap/src/lib.rs:74-160+`).

2. **Fee math bounds (escrow-only)** — for `amount` and `fee_bps` in `0..=10_000`: `0 <= fee <= amount`, `fee + payout == amount` exactly (escrow `lib.rs:343-344`, `158-159`). Atomic-swap has no fee — don't test this invariant there.

3. **State-machine exclusivity (contract-specific, confirmed divergent)**:
   - Escrow: second `resolve()` on a non-disputed trade panics with `TradeNotDisputed` (`lib.rs:132-134`).
   - Atomic-swap: second `release()` call is a silent no-op by design (`lib.rs:141-144`).

4. **Timeout monotonicity** — `refund` never succeeds before `timeout_ledger` (`TimeoutNotReached` guard); `dispute`/normal ops never succeed at/after it.

5. **Secret-hash correctness** — `release` only succeeds when `sha256(secret) == state.secret_hash`; fuzz wrong secrets to confirm `InvalidSecret` every time, in both contracts.

6. **Multisig threshold correctness (escrow-only)** — signer sets below `threshold`, containing duplicates, or containing unauthorized addresses must always fail `require_multisig` (`lib.rs:400+`). Atomic-swap has no multisig — this test doesn't apply there.
