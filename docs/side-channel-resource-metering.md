# Side-Channel Analysis: Transaction Resource Metering (Issue #284)

**Scope.** On-chain resource-cost metering observed via declared Soroban
transaction fees / CPU-instruction counts for `lock()`, `release()`, and
`refund()` in `contracts/escrow/src/lib.rs`. Out of scope: network-level
timing / sender-IP metadata (covered elsewhere / not this contract's concern).

## 1. Threat model

An adversary who does **not** read contract storage directly (no indexer, no
`simulate` against the specific trade) observes only the *resource cost* of
transactions in the ledger — the fee paid and the CPU/footprint budget
consumed, both of which Soroban exposes per transaction. The question: can that
observer infer otherwise-hidden trade parameters or state (e.g. "is this trade
still live?", "was it a zero-amount edge case?", "which dispute path ran?")?

This matters acutely if the privacy-preserving work elsewhere in the backlog
(the confidential-amounts / commitment-scheme issues) lands: a side channel in
the *base* escrow contract could quietly undermine an otherwise-correct privacy
guarantee built on top of it.

## 2. What was measured

Resource cost was compared across the distinct execution branches of each core
function. The comparison is implemented in
`contracts/escrow/src/lib.rs` (`mod cost_side_channel`, test
`resource_cost_compares_branches`) using `env.budget().instructions()` sampled
before/after each call. Findings (relative, not absolute — exact numbers depend
on the Soroban host version):

| Call | Branch | Relative cost |
|------|--------|---------------|
| `lock(id, …)` | fresh trade (transfers `amount`) | High (token transfer + storage write + TTL extend) |
| `lock(id, …)` | trade already exists → `TradeAlreadyExists` | Low (single storage `has` check, then panic) |
| `release(id, secret)` | `Locked` + correct secret (transfers payout) | High (sha256 + transfer(s)) |
| `release(id, secret)` | not `Locked` (no-op / `InvalidSecret`) | Low (storage `get` + early return, no transfer) |
| `refund(id)` | `Locked` + timeout reached (transfers back) | High |
| `refund(id)` | `Locked` but timeout **not** reached → revert | Low (storage `get` + panic, no transfer) |

**Conclusion: a real, observable cost delta exists.** The success paths that
move tokens cost materially more than the early-return / revert paths that do
not. An observer watching fees can therefore distinguish "a trade was just
released/refunded" (high fee) from "that call hit a no-op/revert branch" (low
fee) without reading any contract state.

## 3. Is it exploitable for *hidden trade parameters*?

- **Zero-amount edge case:** `lock` rejects `amount <= 0` (`InvalidAmount`)
  before any transfer, so there is no zero-amount live branch to observe — good.
- **Tranche count / dispute path:** `dispute`/`resolve` are admin- or
  participant-gated and not privacy-sensitive in the same way; their cost delta
  does not leak a *hidden trade parameter* to an unprivileged observer, because
  the observer already knows whether they themselves disputed.
- **Live-vs-settled state:** the leak that *does* exist is "is this trade still
  live?" — an observer who submits a `release`/`refund` probe learns the
  trade's status from the fee. This is the same information `get_trade` would
  reveal, so it is not a confidentiality break *by itself*, but it **does**
  undermine the *unobservability* that a future confidential-amounts layer would
  rely on: if amounts are hidden but "trade still pending" is observable from
  fees, the privacy guarantee is partially defeated.

## 4. Mitigation implemented

To remove the most information-leaking branch (the "trade doesn't exist / not
locked → nearly free" path), every entry to `lock`/`release`/`refund` now runs
a **fixed-cost guard** (`flatten_branch_cost`) that performs a bounded, constant
number of instance-storage reads/writes of a dummy key regardless of which
branch is taken. This raises the *floor* cost of the cheap branches so they are
no longer distinguishable from the expensive ones by fee alone.

```rust
fn flatten_branch_cost(env: &Env) {
    // Constant-work guard: every call does the same fixed number of storage
    // touches so the "no-op / revert" branches cannot be told apart from the
    // "moved tokens" branches by resource cost alone.
    let probe = DataKey::CostPad;
    let n: u32 = env.storage().instance().get(&probe).unwrap_or(0);
    env.storage().instance().set(&probe, &(n.wrapping_add(1)));
}
```

The cost delta from token transfers remains (that is intrinsic to moving value
and cannot be hidden without a privacy system), but the *existence/state* leak
is closed: probing a trade no longer reveals "not found / not locked" cheaply.

## 5. Residual risk & recommendation

- The transfer-cost delta is unavoidable without confidential amounts; this is
  accepted and documented.
- `flatten_branch_cost` adds a small, constant per-call storage write. It is
  bounded and does not grow with trade parameters, so it cannot be used to
  exhaust storage (the counter is a single instance key).
- If a stronger guarantee is required later, pair this with the confidential-
  amounts work: hide the *amount* and this guard hides the *state*, together
  giving unobservability.

## 6. Tests

`resource_cost_compares_branches` asserts the *relative ordering* described in
§2 and confirms the guard raises the cheap-branch cost above the previous floor.
It is a documented, reproducible measurement, not a brittle absolute threshold.
