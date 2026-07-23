# Escrow On-chain Anomaly Monitoring

The API process starts `EscrowAnomalyMonitor` after it begins listening. The
monitor follows the repository's existing Soroban convention: it polls RPC
`getEvents` every five seconds, filters by `ESCROW_CONTRACT_ID`, and advances a
ledger cursor so already-seen events are not processed again.

Alerts use `sendWebhookAlert` in `apps/api/src/lib/webhook.ts`. This is the same
`REFUND_WEBHOOK_URL` Slack/Discord operations channel used for refund alerts;
the monitor does not introduce another notification destination.

## Contract event shapes

The current escrow contract emits these topic/value shapes:

| Event | Topics | Value |
| --- | --- | --- |
| Lock | `locked`, trade id (`BytesN<32>`) | amount (`i128`, stroops) |
| Release (including successful batch items) | `released`, trade id | seller payout (`i128`, stroops) |
| Refund | `refunded`, trade id | amount (`i128`, stroops) |
| Dispute | `disputed`, trade id | caller address tuple |
| Resolution | `resolved`, trade id | `(resolve_to_buyer, amount)` |

The contract does not emit a failed-release event because a failed Soroban
invocation rolls back its contract events. Repeated release failures are
therefore read from unsuccessful RPC diagnostic `fn_call` events for the
escrow's `release` function. The RPC/indexer used in production must retain and
serve diagnostic events. Indexers that normalize those diagnostics as
`release_failed` are also accepted. No escrow-contract change is required.

## Thresholds

Thresholds are rolling-window rules, evaluated in event close-time order:

- **Unusual volume:** alert when locks in five minutes total at least
  `1,000,000,000,000` stroops (100,000 USDC at seven decimals), or when at
  least 25 locks occur. The amount rule catches concentrated value exposure;
  the count rule catches bursts split into smaller trades. These conservative
  initial values avoid alerting on ordinary early-stage activity and should be
  calibrated from production baselines.
- **Repeated failed releases:** alert on the third failed `release` call for
  the same trade id within ten minutes. One or two failures commonly represent
  a stale client or mistyped/incorrect QR secret; a third attempt is more likely
  automation, probing, or a client stuck in an unsafe retry loop.

One alert is sent per active volume window and per affected trade id, preventing
a busy incident from flooding the webhook. The monitor is complementary to the
API rate-limit violation system: that system tracks request frequency by IP and
route, while this service observes confirmed on-chain and diagnostic activity.

Set `ESCROW_MONITOR_START_LEDGER` to an explicit ledger when replay/backfill is
needed. If omitted, monitoring starts at the RPC node's latest ledger.
