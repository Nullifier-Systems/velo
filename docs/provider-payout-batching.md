# Provider Payout Batching

**Status:** Implemented, opt-in.
**Related:** [docs/transaction-batching-feasibility.md](transaction-batching-feasibility.md) (issue #205 research)

## Summary

Providers can opt into **batched payouts**: instead of every completed
trade triggering its own `release()` transaction, a provider's revealed
secrets are queued and settled together in one on-chain transaction, on a
schedule or once enough have accumulated. Immediate per-trade release
remains the default — nothing changes for a provider who doesn't opt in.

## Why this needed a contract change

[docs/transaction-batching-feasibility.md](transaction-batching-feasibility.md)
(section 6.1) suggested that Soroban's 100-operations-per-transaction limit
could be used to pack multiple `release()` invocations into one Stellar
transaction. **That doesn't hold**: Soroban restricts a transaction to
exactly one `InvokeHostFunctionOp`. The 100-operation limit applies to
classic Stellar operations (native payments, trustlines, etc.), not to
contract invocations. Multiple contract calls can only be made atomic by
having *one* contract invocation call into other contracts internally —
not by stacking sibling operations in a transaction. (See the [Stellar
docs on invoking contracts](https://developers.stellar.org/docs/learn/fundamentals/contract-development/contract-interactions/stellar-transaction).)

So the only way to actually reduce transaction count — and therefore fees
— is a contract function that settles many trades inside a single
invocation: `batch_release()`.

## On-chain: `batch_release()`

Added to `contracts/escrow/src/lib.rs` alongside the existing `release()`.

```rust
pub fn batch_release(env: Env, releases: Vec<BatchReleaseItem>) -> Result<Vec<BytesN<32>>, Error>
```

Each `BatchReleaseItem { id, secret }` is verified **independently**,
exactly like `release()` verifies a single trade:

- looks up the trade by `id`; must be `Locked`
- checks `sha256(secret) == secret_hash`
- pays the seller (minus platform fee) and the fee recipient
- marks the trade `Released`

An item that fails any of these checks (unknown id, wrong secret, already
settled) is **skipped**, not treated as a batch-wide failure. This matters:
one stale or malformed entry must not be able to block payout for every
other provider swept up in the same batch. The function returns the ids it
actually released, so the caller knows what to retry.

The only thing that aborts the whole call is `releases.len() >
MAX_BATCH_SIZE` (25) — a guard against a batch large enough to blow
Soroban's per-invocation compute budget.

### Trustless guarantee — unchanged

Batching does not introduce a new trust assumption:

- Each trade's payout is still gated by its own secret hash, checked
  on-chain, independent of every other item in the batch.
- `batch_release()` is permissionless, exactly like `release()` — no new
  custody, no signer whose authority spans multiple trades.
- The API already sees the secret in the existing custodial `/release`
  flow (the merchant submits `{ secret }` and the API calls `release()`
  with it). Batching holds that same secret server-side for longer (up to
  the batch window) instead of submitting it immediately — a latency
  change, not a new custody risk: `release()`/`batch_release()` always pay
  the seller address recorded in the trade's locked state, never a caller-
  supplied address, so holding the secret longer doesn't let anyone
  redirect funds.

## Off-chain: the batch coordinator

`apps/api/src/lib/payout-batcher.ts` is the off-chain half:

1. When a trade's release is requested (`POST /cash/request/:id/release`
   with `{ secret }`) and the trade's provider has opted into batching,
   `store.ts#enqueueForBatch` stores the secret and flips the trade to
   `pending_batch` instead of calling `release()` immediately.
2. A background scheduler polls every `PAYOUT_BATCH_POLL_INTERVAL_MS`
   (default 30s) and flushes a provider's queue once either:
   - it has **`PAYOUT_BATCH_THRESHOLD_COUNT`** (default 5) trades queued, or
   - its oldest queued trade has waited **`PAYOUT_BATCH_WINDOW_MS`**
     (default 5 minutes) — a latency ceiling so a slow trickle of trades
     doesn't wait forever.
3. Flushing calls `batchReleaseEscrow()` (`apps/api/src/lib/stellar.ts`)
   once for up to `PAYOUT_BATCH_MAX_SIZE` (default 25, matching the
   contract's cap) queued trades, in one Soroban transaction.
4. Whatever the contract actually released moves to `released` (same
   notification/webhook path as immediate release). Anything it skipped,
   or the whole call failing (e.g. simulation error), stays
   `pending_batch` and is retried on the next tick — nothing is silently
   dropped.

### Opting in

```
POST /provider/payout-settings
x-provider-address: G...
{ "payout_mode": "batched" }
```

Default is `"immediate"` (today's behavior). This is opt-in, not a global
default, because it trades payout latency for fee savings — a call each
provider should make for themselves, not one imposed on everyone.

## Tradeoffs

| | Immediate (default) | Batched (opt-in) |
|---|---|---|
| Payout latency | Sub-minute (one `release()` call) | Up to `PAYOUT_BATCH_WINDOW_MS`, or sooner if the provider's queue hits the count threshold |
| On-chain transactions | One per trade | One per up to `PAYOUT_BATCH_MAX_SIZE` trades |
| Failure isolation | Per-trade | Per-batch — one bad/expired entry is skipped, not fatal, but a failed *submission* (e.g. RPC error) delays the whole queued group until the next tick |
| Server-held secret window | Until the single `release()` call completes (seconds) | Until the batch fires (up to the window) |
| Best for | Low-volume providers, or anyone who wants funds the moment a trade completes | High-volume providers where the aggregate fee savings across many trades outweighs waiting for the window |

This lines up with the "medium-term" recommendation in
[docs/transaction-batching-feasibility.md](transaction-batching-feasibility.md#72-medium-term-100-500-tradesday):
batch only for providers who choose it, rather than imposing latency on
everyone for a saving that's negligible at low volume.

## Configuration

All optional, read from environment variables by
`apps/api/src/lib/payout-batcher.ts`:

| Variable | Default | Meaning |
|---|---|---|
| `PAYOUT_BATCH_WINDOW_MS` | `300000` (5 min) | Max time a trade waits before its provider's batch is forced out |
| `PAYOUT_BATCH_THRESHOLD_COUNT` | `5` | Flush as soon as a provider's queue reaches this many trades |
| `PAYOUT_BATCH_POLL_INTERVAL_MS` | `30000` (30s) | How often the scheduler re-checks queues |
| `PAYOUT_BATCH_MAX_SIZE` | `25` | Cap per `batch_release()` call — mirrors the contract's `MAX_BATCH_SIZE` |

## Known limitations / follow-ups

- **Custodial only, for now.** `batchReleaseEscrow()` signs with the same
  testnet-only backend key used by today's custodial `release()`/`lock()`
  path (see [docs/non-custodial-escrow-flow.md](non-custodial-escrow-flow.md)).
  Before mainnet, this needs the same treatment the rest of the escrow
  flow is getting: a dedicated relayer key (or a rotation of one), not a
  developer-held secret.
- **In-memory queue.** Like the rest of `store.ts`, the pending-batch queue
  is a process-local `Map` — it doesn't survive a restart. A queued trade
  would need to be re-submitted by the merchant if the API restarts mid-window.
- **No per-provider window/threshold customization** — the schedule and
  threshold are global settings, not per-provider preferences. Only the
  opt-in itself is per-provider.
