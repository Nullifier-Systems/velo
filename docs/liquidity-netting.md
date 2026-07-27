# Cross-instance liquidity netting -- clearing engine (#277)

This document describes the off-chain clearing/netting engine added in
`apps/api/src/lib/liquidity-netting.ts`, the invariant it proves, how it handles
partial failure, and how it maps onto an on-chain coordinating contract.

## Problem

Velo runs one escrow instance per settlement token, and the instances are
entirely independent. A provider active in several tokens has liquidity
fragmented and must post full reserves in every instance. We want to net
obligations across instances so a provider needs reserves for its *net*
position, not its gross activity -- without ever letting netting manufacture
value that is not backed by a real locked reserve.

## Model

- An `Obligation` is value owed within one instance: `{ instance, debtor,
  creditor, amount }`.
- A `LockedReserve` is what a party actually has locked in an instance:
  `{ instance, owner, amount }`.
- `computeNetPositions` collapses obligations to one `NetPosition` per
  `(instance, party)`. Positive = net creditor, negative = net debtor.

## The invariant, and why it holds

**Conservation.** Every obligation adds `+amount` to its creditor and `-amount`
to its debtor within the same instance. Therefore, for each instance, the sum of
all net positions is exactly zero -- by construction. `assertConservation`
re-checks this and throws on any non-zero sum, which is exactly the "value
conjured from nowhere" failure mode.

**Backing.** In `computeSettlement`, every net debtor must have a locked reserve
of at least their net debit. Because collections equal payouts per instance
(conservation) and each collection is bounded by that party's reserve, total
payout per instance can never exceed total locked reserves. `verifyNoUnbackedValue`
re-derives this independently from the emitted instructions: per instance,
collected == paid, payout <= total reserves, and every individual collection is
backed by the collector's own reserve.

Net effect: netting reduces the reserve a provider must post (from gross to net)
but can never let an instance pay out more than is genuinely locked.

## Partial failure is treated as total failure

Settlement is **atomic across instances**. If any net debit in any instance is
unbacked, `computeSettlement` returns `status: "rejected"` with the offending
violations and **emits no instructions at all** -- even for an instance that was
fully backed on its own. A partially-applied cross-instance settlement (instance
A pays out while instance B fails to collect) is precisely how unbacked value
would leak, so it is disallowed.

## What this is, and what it is not

- This is the **reference clearing engine and its invariant proof**, implemented
  and exhaustively tested off-chain. It imports nothing from the escrow contract
  and changes no existing behaviour.
- It is **not** the deployed on-chain coordinating contract, and it does not do
  cross-token FX. Netting is computed per instance/token; a net creditor in one
  token is not automatically paid from another token's reserves.
- Scope is **two instances**, matching the issue. Three or more is explicitly
  rejected.

## On-chain follow-up

An on-chain coordinating contract would mirror this logic: both escrow instances
register obligations with the clearing contract, which computes net positions,
verifies each net debit against the reserve locked in the corresponding escrow
instance, and drives settlement atomically (all instances or none). This engine
is the specification and test oracle for that contract; wiring the escrow
instances (`contracts/escrow/src/lib.rs`) to register with a clearing contract
is the follow-up and is intentionally out of this slice.

## Tests

`apps/api/src/lib/liquidity-netting.test.ts` proves conservation, the correct
netted balances for a provider active in two instances, the reserve-requirement
reduction (gross vs net), rejection when a net debit exceeds locked reserves,
cross-instance atomicity (one unbacked instance rejects the whole batch),
out-of-scope rejection beyond two instances, and detection of a fabricated net
set that conjures value.