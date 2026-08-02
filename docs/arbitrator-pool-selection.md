# Permissionless, Collusion-Resistant Arbitrator Selection

**Status:** Implemented, opt-in.
**Related:** issue #279. Layers on top of issue #275 (`raise_dispute()`,
`resolve_dispute()`, the single `Arbitrator` address, and the
`DisputeDeadline` timeout fallback), which landed while this issue was in
progress.

## Summary

Issue #275 gave the escrow contract a real dispute-resolution mechanism: a
distinct `arbitrator: Address` set at `initialize()`, `resolve_dispute()`
that can split locked funds between buyer and seller, and a
`DisputeDeadline`-based timeout so an unresponsive arbitrator can never
freeze funds. That `arbitrator` is a single, fixed address, known to both
parties from the moment the contract is initialized — a reasonable
starting point, but a collusion risk once arbitration needs to be trusted
at real scale: both sides of a trade know in advance exactly who decides
a dispute.

This adds an opt-in **arbitrator pool** on top of that foundation: any
address can register (`join_arbitrator_pool`), and when a trade is
disputed, one pool member is drawn to resolve it — unpredictably, before
the draw happens, and in a way neither party nor the arbitrators
themselves can influence.

If no arbitrators have registered (or none are eligible yet — see below),
`resolve_dispute()` falls back to the single `Arbitrator` exactly as #275
built it. Populating the pool is what activates selection — nothing
changes for existing deployments until they opt in.

## Mechanism

### 1. Snapshot eligibility when the dispute is raised, not when it resolves

`raise_dispute()` immediately records, in a `DisputeSelection` record keyed
by trade id (alongside the `DisputeDeadline` #275 already sets):

- `eligible`: every pool member who is currently active *and* has been
  continuously active for at least `ARBITRATOR_ACTIVATION_LEDGERS`
  (~1 day) as of that exact ledger.
- `reveal_ledger`: `raised_ledger + ARBITRATOR_SELECTION_DELAY_LEDGERS`.

This snapshot is frozen. Nothing that happens afterward — an arbitrator
joining, leaving, or the admin doing anything at all — can change who was
eligible for *this* dispute. That directly answers the "can't be gamed by
strategically joining/leaving around specific disputes" requirement:

- **Joining right before a dispute doesn't help.** A new member only
  becomes eligible a full activation window after they joined. Since the
  snapshot is taken at raise time, anyone who joined in reaction to seeing
  a `lock()` (or colluding with a party who's about to dispute it) is
  necessarily excluded — they haven't been in the pool long enough yet.
- **Leaving right after a dispute doesn't help either.** `eligible` is a
  copy, not a live reference to pool membership. An arbitrator who was
  eligible when the dispute was raised stays eligible for that dispute's
  draw even if they call `leave_arbitrator_pool` a moment later (that call
  itself is blocked anyway — see below — once they're actually selected,
  but even before selection, leaving doesn't remove them from an
  already-taken snapshot).
- **Leave/rejoin cycling doesn't help.** Rejoining resets
  `joined_ledger` to the current ledger, so it restarts the activation
  clock from zero. There's no way to "bank" activation time, drop out, and
  reappear pre-activated for a specific upcoming dispute.
- **An arbitrator can't dodge a dispute once drawn.** `leave_arbitrator_pool`
  fails while `pending_disputes > 0`. The count is incremented by
  `select_arbitrator` and only decremented by that specific dispute
  resolving (`resolve_dispute()`) or timing out
  (`refund_after_dispute_timeout()`).

### 2. Draw the winner later, in a separate, permissionless, one-shot call

`select_arbitrator(id)` can be called by anyone, but only once
`env.ledger().sequence() >= reveal_ledger`. It draws a uniform index into
`eligible` using `env.prng()` and stores the winner. Two properties matter
here:

- **It's a separate transaction from `raise_dispute()`.** The party
  raising the dispute never controls the transaction whose inclusion
  determines the outcome — anyone (a keeper bot, either party, an
  arbitrator, a bystander) can be the one to call `select_arbitrator`, and
  the result is identical regardless of who calls it, because the
  function takes no caller argument at all and the seed comes purely from
  the PRNG.
- **It's one-shot.** Once `selected` is `Some(_)`, further calls just
  return the existing value instead of redrawing. This is what actually
  rules out grinding: there is no "try again if you don't like the result"
  — a party who wanted to influence the outcome would need to preview it
  before submitting, and there is no way to do that (see below).

### 3. Why the randomness is actually unpredictable at the time it matters

Selection uses `env.prng()`, Soroban's host-provided PRNG. Per
[`soroban_sdk::prng`'s own documentation](https://docs.rs/soroban-sdk/latest/soroban_sdk/prng/index.html):

> The network runs in strict consensus, so every node in the network seeds
> its PRNG with a consensus value... the seed is derived from the overall
> transaction-set hash and the hash-sorted position number of each
> transaction within it. This seed is not secret and not cryptographically
> hard to bias if a corrupt validator were to choose to do so... but [is]
> generally difficult for network users to bias to a specific value.

Two consequences drive the design here:

- **The seed for a given invocation doesn't exist until that invocation's
  transaction is actually included in a nominated ledger.** A party
  cannot simulate `select_arbitrator` ahead of time and only submit it if
  the outcome is favorable, because Soroban preflight/simulation runs
  against the *current* ledger state and cannot know a future ledger's
  transaction-set hash — that hash is exactly the thing that hasn't been
  decided yet. Combined with the one-shot property above, there is no
  "free roll": the only way to learn the outcome is to submit the real
  transaction, at which point the dispute is already resolved.
- **A single ordinary user cannot grind by resubmitting variants.** Because
  selection happens in its own transaction, decoupled from
  `raise_dispute()`, and doesn't depend on the caller, there's no
  meaningful "which of my own transaction's field values gives me a
  favorable draw" search to run — changing memo/fee/sequence on a
  *different* transaction than the one that will actually execute the
  draw has no effect on it.

This is honestly weaker than a VRF or an off-chain trusted-entropy
commit/reveal: the docs are explicit that a **corrupt validator** could in
principle bias the transaction-set hash. That risk is accepted here for
the same reason the SDK's own docs describe it as usable for
"commit/reveal schemes... or similar advanced pseudo-random contract
behaviour" — it is a materially stronger source than any other on-chain
data a contract could derive (ledger sequence, timestamp, a counter), and
the delay + one-shot-draw + separate-transaction design closes off every
practical grinding vector available to the disputing parties or the
arbitrators themselves, which is the actual threat model this issue asks
for ("neither party nor arbitrators can predict or manipulate"). A
validator-level attack is a materially different, network-level threat
that no contract-side mechanism can fully close; it is out of scope for
this issue (see #279's "Out of scope: arbitrator reputation/removal
governance" — validator-level collusion resistance would need a
different, off-chain or protocol-level mitigation).

### 4. Unresponsive arbitrator fallback

This reuses #275's existing mechanism rather than duplicating it:
`DisputeDeadline` is set the moment the dispute is raised, independent of
whether or when `select_arbitrator` is ever called, and
`refund_after_dispute_timeout()` is permissionless once it elapses. This
PR's only addition there is bookkeeping: if a pool arbitrator had been
drawn for the trade, their `pending_disputes` slot is freed and the
`DisputeSelection` record is cleaned up, so an arbitrator who goes silent
is not permanently stuck in the pool either.

## What's deliberately out of scope here

- **Partial-split resolution mechanics** (`resolve_dispute(buyer_share_bps)`)
  are unchanged — this issue only changes *who* is authorized to call it
  once a pool exists, not what it does.
- **Arbitrator reputation, slashing, or removal governance** — explicitly
  out of scope per #279. Sybil resistance here rests entirely on the
  activation delay (an attacker can register many addresses, but none of
  them are eligible for a dispute they didn't anticipate a full activation
  window in advance). A staking/bonding requirement would raise the cost
  of Sybil registration further; that's a natural follow-up but is
  reputation/governance-adjacent and was left for a separate issue.

## Storage shape

New `DataKey` variants, all local to `contracts/escrow` (nothing in the
shared `htlc-core` crate or `TradeState`/`TradeStatus` changed here, so
`atomic-swap` is unaffected by this PR):

- `ArbitratorPool` — `Vec<Address>`, append-only, instance storage.
- `ArbitratorMember(Address)` — `ArbitratorMeta { joined_ledger, active,
  pending_disputes }`, persistent storage. Distinct from #275's unit-variant
  `DataKey::Arbitrator`, which still holds the single fallback address.
- `DisputeSelection(BytesN<32>)` — `DisputeSelection { raised_ledger,
  reveal_ledger, eligible, selected }`, persistent storage, removed once
  the dispute resolves or times out. Sits alongside #275's
  `DisputeDeadline(BytesN<32>)`, which still owns the timeout ledger.
