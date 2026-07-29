# Escrow-to-Escrow Atomic Trade Chaining

## Overview

`chain_release_to_lock()` on the escrow contract lets a cash provider who
just received funds in one trade (trade A) re-circulate that same value
into a new trade (trade B) in a single Soroban invocation. Trade A's
release logic and trade B's lock logic execute atomically, and the payout
never leaves the contract's own token balance — it moves directly from
being trade A's escrowed amount to being trade B's escrowed amount.

Without this, re-circulating funds requires trade A's `release()` to pay
out to the seller's wallet, then a separate `lock()` transaction to bring
the same value back in — two transactions, with the funds briefly outside
the contract in between.

## Why chaining needs its own authorization model

`release()` is deliberately permissionless: whoever supplies the secret
that hashes to `secret_hash` triggers payout to `seller`, regardless of who
calls it. That's safe because `release()` can only ever do one thing with
the funds — pay the fixed `seller` address recorded at `lock()` time.

Chaining is a different kind of action. It redirects that same payout into
a *new* trade with a new counterparty (`new_seller`), a new secret hash,
and a new timeout — parameters the caller of `chain_release_to_lock()`
chooses, not `lock()`'s original buyer. If chaining were as permissionless
as `release()`, anyone who merely observed `release_secret` (for instance
by watching it get revealed at a cash hand-off) could redirect someone
else's incoming payout into a trade the attacker controls: a different
`new_seller`, a self-chosen `new_secret_hash` whose preimage only the
attacker knows, and a timeout of the attacker's choosing. The rightful
recipient would never see their money, and would have no recourse other
than waiting out `new_timeout_ledgers` for a refund back to... whichever
`buyer` address the attacker recorded, which is `release_state.seller` —
so even the refund path stays correct, but the funds could sit locked
under terms the legitimate recipient never agreed to for however long the
attacker sets `new_timeout_ledgers`.

### The gate: `release_state.seller.require_auth()`

`chain_release_to_lock()` requires an explicit authorization from
`release_trade_id`'s `seller` — the same address `release()` would have
paid — in addition to the secret check. This is strictly stronger than
`release()`'s authorization (secret-only), and that asymmetry is
intentional:

- Knowing the secret is sufficient to trigger an ordinary payout to
  `seller`'s wallet, because that payout's destination and terms were
  fixed back at `lock()` time and can't be redirected.
- Knowing the secret is **not** sufficient to redirect that payout into a
  trade of the caller's own choosing — only `seller`, the party the funds
  are rightfully owed to, can consent to that.

`release_trade_id`'s `buyer` needs no additional say here. From their
point of view chaining is indistinguishable from an ordinary `release()`:
the same secret is checked against the same `secret_hash`, and their trade
ends up `Released` either way. Nothing about their side of the deal
changes.

The new trade's `buyer` is always `release_trade_id`'s `seller` — the
party recirculating its own incoming funds into a new deal. `new_seller`
is simply the counterparty they choose for that new trade, exactly as any
`lock()` caller chooses their own `seller`.

## What's tested against this model

`contracts/escrow/src/lib.rs` (`mod test`) covers:

- `chain_release_to_lock_relocks_the_payout_without_an_external_transfer` —
  the full chain: trade A ends `Released`, trade B is created `Locked`
  with the correct counterparties and amount, and `seller` never receives
  a wallet transfer — the payout only ever moves between two trades'
  escrowed balances inside the contract.
- `chain_release_to_lock_requires_release_trade_sellers_authorization` —
  an outsider who is not `release_trade_id`'s seller cannot authorize the
  chain (using `soroban_sdk::testutils::MockAuth` to simulate a
  transaction actually signed by the wrong address, since
  `mock_all_auths()` alone can't distinguish "some address authorized
  this" from "the *correct* address authorized this"); the legitimate
  seller can.
- `chain_release_to_lock_rejects_wrong_secret` and
  `chain_release_to_lock_cannot_be_replayed_against_an_already_released_trade`
  — the usual `release()`-style guards still apply to the release half of
  the operation.
- `chained_trade_can_be_refunded_after_its_own_timeout_like_any_trade` and
  `chained_trade_can_be_disputed_and_resolved_like_any_trade` — trade B is
  a completely ordinary trade afterward; `refund()`, `dispute()` and
  `resolve()` all behave on it exactly as they would on any `lock()`-
  created trade.

## Distinguishing chained operations off-chain

`chain_release_to_lock()` publishes two events instead of reusing
`release()`'s and `lock()`'s event symbols, so off-chain systems (like the
API's chat/notification integrations) can tell a chained operation apart
from two independent ones without having to correlate timestamps or
amounts:

- `("chain_rel", release_trade_id) -> (new_trade_id, payout)`
- `("chain_lock", new_trade_id) -> (release_trade_id, payout)`

Each event carries the other trade's id, so a listener can reconstruct the
link from either side.

## New trade id derivation

`chain_release_to_lock()` takes no explicit id for trade B — its signature
mirrors the issue's request exactly: `release_trade_id`, `release_secret`,
`new_seller`, `new_secret_hash`, `new_timeout_ledgers`. The new trade's id
is derived deterministically on-chain as
`sha256(release_trade_id || new_secret_hash)` and returned to the caller.
A collision would require a sha256 preimage, and even then the existing
`TradeAlreadyExists` check on that derived id would reject it — the same
protection `lock()` already relies on for caller-supplied ids.

## API integration

`POST /api/v1/cash/request/:id/chain` (`apps/api/src/routes/cash.ts`)
exposes this as a two-step, non-custodial-only flow, because the contract
requires trade A's `seller` to sign — a key the API never holds:

1. `POST` without `signed_xdr` — the API builds and simulates the
   `chain_release_to_lock()` transaction (source account = trade A's
   `seller`) and returns unsigned XDR for that seller to sign client-side.
2. `POST` again with `signed_xdr` — the API submits the signed envelope,
   decodes the new trade id from the contract call's return value, reads
   trade B's on-chain state to learn its actual (post-fee) amount, and
   persists a new cash-request record for trade B linked back to trade A
   via `chainedFromId`/`chainedToId`.

There is no custodial fallback for this endpoint, unlike `/request` and
`/request/prepare`, which can sign on testnet using a shared
`BUYER_SECRET_KEY`. The seller in a chain call is not the same well-known
signer, and using it here would defeat the exact authorization boundary
described above.
