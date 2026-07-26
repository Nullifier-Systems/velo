# Escrow contract versioning and migration

Each escrow instance is initialized with one settlement token. That binding is
immutable, so Velo treats a deployed contract as a versioned
`(settlement asset, contract id)` pair rather than as a global singleton.

## Runtime registry

The API reads `ESCROW_CONTRACTS_JSON` at startup. The value is an array:

```json
[
  {
    "asset": "USDC",
    "contractId": "C...V2",
    "version": "2.0.0",
    "status": "active"
  },
  {
    "asset": "USDC",
    "contractId": "C...V1",
    "version": "1.0.0",
    "status": "draining"
  },
  {
    "asset": "XLM",
    "contractId": "C...XLM",
    "version": "1.0.0",
    "status": "active"
  }
]
```

Exactly one deployment may be `active` for an asset. New cash requests include
`settlement_asset` (default `USDC`), and the API selects that asset's active
deployment. Adding a token or switching versions is therefore a configuration
rollout and API restart, not an application code deployment. Invalid or
ambiguous registries fail during API startup instead of silently routing funds.

`GET /api/v1/cash/contracts` exposes the active asset-to-contract mappings.
Creation responses also include `contract_id` and `settlement_asset`, and the QR
payload carries the selected contract id.

For backwards compatibility, `ESCROW_CONTRACT_ID` remains the single-USDC
fallback when `ESCROW_CONTRACTS_JSON` is not set.

## Deployment states

- `active`: accepts new trades and remains monitored.
- `draining`: accepts no new trades, but remains monitored while old trades
  settle or refund.
- `retired`: accepts no new trades and is no longer monitored by the API.

The registry state controls only new routing and monitoring. It never rewrites a
trade's contract binding.

## Migration procedure

1. Deploy and initialize the new instance with the intended token. Record the
   contract id, source commit, WASM hash, semantic version, network, token SAC,
   admin/signers, and deployment ledger.
2. Exercise lock, release, refund, dispute, timeout, and batch-release paths on
   the target network.
3. Add the new instance as `draining` first so monitoring can observe it without
   sending user funds.
4. In one reviewed configuration change, mark the old instance `draining` and
   the new instance `active`; restart the API and verify
   `GET /api/v1/cash/contracts`.
5. Keep the old instance, signer policy, RPC history, and alerting available
   until every bound trade is terminal and its maximum refund window has
   elapsed.
6. Mark the old instance `retired`. Do not remove its deployment record from the
   audit history or destroy keys needed for dispute resolution.

Rollback reverses step 4: mark the new instance `draining` and the prior
compatible instance `active`. Trades already created on either instance
continue on the contract recorded at creation.

## In-flight trade guarantee

Every cash-request record persists both `contractId` and `settlementAsset`.
Release, refund, dispute, signed-transaction submission, QR reconstruction, and
provider payout batching use the record's immutable `contractId`; they do not
re-resolve the current registry. Consequently, changing the active USDC
deployment cannot redirect an existing USDC trade.

The production database schema must keep `cash_requests.contract_id` non-null.
Rows created before asset tracking can derive the asset from deployment history,
but their contract id must never be replaced. Backups and migrations must
preserve this field.

## Compatibility policy

Contract versions may coexist only when the API understands every live
instance's ABI. An ABI-breaking release requires additive API support before it
can enter `draining` or `active`. Removing old ABI support is safe only after no
non-terminal trade references that version and the dispute/refund retention
period has elapsed.
