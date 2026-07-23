# RPC Resilience — Timeout Policy and Progressive UX

This document records the deliberate decisions made in response to
[issue #235](https://github.com/Nullifier-Systems/velo/issues/235):
*what happens when the Soroban RPC node is slow or unreachable?*

---

## The core tension

Every Soroban call in `lib/stellar.ts` goes through two phases:

1. **Build + simulate** — `getAccount` then `simulateTransaction`. These are
   read-only and return quickly under normal conditions (~1–2 s), but a
   congested or restarting node can stall for many seconds.

2. **Submit + poll** — `sendTransaction` followed by repeated
   `getTransaction` calls until the ledger closes and the result is visible.
   Stellar's ledger closes every ~5–6 s, but the RPC view of a confirmed
   transaction can lag by multiple close cycles.

If we wait indefinitely we risk:
- the HTTP request hanging until the client times out or closes the connection,
- the user seeing a frozen spinner with no way to know if their funds are safe,
- the operator having no signal in the logs that anything is wrong.

If we time out and tell the user to retry, we risk:
- a double-submit: the original transaction may still land on-chain after we
  gave up, and a retry would attempt to lock the same trade ID a second time
  (which the contract rejects, but the user doesn't know that).

There is no timeout value that avoids both risks simultaneously.
The choices below are a documented bet, not a perfect answer.

---

## Timeout values

These are defined as the `RPC_TIMEOUTS` constant in `lib/stellar.ts`.

| Operation          | Phase          | Budget   | Rationale                                                                                      |
|--------------------|----------------|----------|-----------------------------------------------------------------------------------------------|
| `lock`             | build + sim    | 15 s     | `getAccount` + `simulateTransaction`. Lock is the highest-value operation so we give it more room than release/refund. |
| `lock`             | poll           | 45 s     | Allows ~7–8 ledger close cycles — enough to survive a brief RPC catch-up lag without being unreasonable. |
| `release`          | build + sim    | 10 s     | Same as refund; read-only phase is cheaper.                                                   |
| `release`          | poll           | 30 s     | ~5 close cycles. Release is triggered interactively by the merchant so a shorter budget is acceptable. |
| `refund`           | build + sim    | 10 s     | Same as release.                                                                              |
| `refund`           | poll           | 30 s     | Same as release.                                                                              |
| generic (non-custodial) | build + sim | 15 s | Matches lock budget for the signed-XDR submission path.                                      |
| generic (non-custodial) | poll       | 30 s | Same as release/refund.                                                                       |

These values are environment-independent. They apply equally on testnet and
mainnet. If operational experience shows them to be consistently too tight or
too loose, adjust `RPC_TIMEOUTS` in `lib/stellar.ts` — the values are
co-located for that reason.

---

## What callers see on timeout

`stellar.ts` throws `RpcTimeoutError` (a subclass of `Error`) when a budget
expires.  `cash.ts` routes catch it by `instanceof` and reply with HTTP **504**
and `error: "rpc_timeout"` rather than the generic 502 used for all other
failures.

```json
{
  "error": "rpc_timeout",
  "detail": "RPC timeout: lock/buildSim did not complete within 15000 ms",
  "operation": "lock/buildSim",
  "elapsed_ms": 15003
}
```

This lets API consumers (including the Telegram bot example and any agent
integration) distinguish *the RPC was too slow* from *something else broke*,
and apply different retry logic accordingly.

---

## Double-submit risk

The most dangerous scenario is a lock that times out during the **poll** phase:
the transaction has already been submitted to the network, but we gave up
waiting for confirmation. If the caller retries with a fresh trade ID, it will
generate a new transaction — but if the original one still lands, funds are
locked in escrow against the **old** trade ID, not the new one. The user ends
up holding a QR for a trade that will never be claimed.

Mitigations already present in the codebase:

- The escrow contract rejects a `lock()` call for a trade ID that already
  exists, so a true duplicate submission is safe.
- All `release` and `refund` routes do an idempotency check *before* throwing
  the 502/504: if the record has already transitioned to the expected terminal
  state (possibly confirmed between the timeout and the error handler running),
  they return 200 rather than an error.
- The `release` route's signed-XDR path does the same check after a failed
  `submitReleaseTx`.

What is **not** mitigated:

- A lock poll timeout that results in a 504 but the transaction later lands.
  The trade record is *not* saved in this case, so the claim URL is never
  issued. A human operator or the buyer would need to inspect the chain to
  recover. This is the accepted tradeoff: we prefer a clear failure with no
  orphaned record over silently issuing a claim URL whose underlying state is
  unknown.

A future improvement would be to save the trade record in a `pending_lock`
state before submitting, then allow the `/submit` endpoint (or a background
reconciler) to promote it to `locked` once the transaction is confirmed —
regardless of which process originated the submission. This would eliminate
the orphan risk entirely at the cost of more complex state management.

---

## Progressive frontend UX

The ClaimQR page shows the user a `WaitingBanner` component during any
operation that talks to the API. The banner message escalates on a fixed
schedule aligned to the backend budget:

| Elapsed time | Message |
|---|---|
| 0 – 5 s | "Locking escrow on Stellar…" |
| 5 – 15 s | "Taking a bit longer than usual — the RPC node may be busy. Your funds are safe." |
| 15 – 30 s | "Still working. The transaction has been submitted; we're waiting for on-chain confirmation." |
| > 30 s | "This is taking unusually long. You can safely close this page and check back in a few minutes — if the transaction landed, the status will update automatically." |

The thresholds are defined as `WAIT_LONGER_MS`, `WAIT_STILL_MS`, and
`WAIT_CHECK_BACK` in `ClaimQR.tsx`. They are intentionally slightly shorter
than the backend budgets so the user sees a message before the API actually
gives up — not after.

The banner uses `aria-live="polite"` and `aria-atomic="true"` so screen
readers announce the escalating message without interrupting ongoing speech.

The decision to show explicit times ("5s elapsed") rather than a progress bar
was deliberate: a progress bar implies a known upper bound; these RPC waits do
not have one. A raw counter is more honest.

---

## What was not done (and why)

**A retry queue / background job**: the cleanest solution long-term. Rejected
for this iteration because it requires persistent state, a worker process, and
a reconciliation loop that the current in-memory store cannot support cleanly.
Filed as a follow-up.

**Exponential back-off on the poll loop**: the current 1.5 s fixed interval is
fine for the poll budget sizes chosen. Exponential back-off would reduce RPC
load on extremely slow nodes at the cost of increased latency in the normal
case. Not worth the complexity now.

**Per-environment timeout overrides via env vars**: tempting, but adds surface
area. Operators who need different values should change `RPC_TIMEOUTS` in code
and deploy — the values are intentionally co-located and documented here.
