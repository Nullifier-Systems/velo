# Soroban Storage Rent & TTL Management

## Overview

Soroban uses a rent-based storage model: entries in `Persistent` and `Temporary` storage have a Time-To-Live (TTL) measured in ledgers. Once the TTL expires, the entry becomes **archived** and can no longer be read by contract code. Archived entries may be reclaimed (deleted) by validators.

Instance storage (`env.storage().instance()`) TTL is managed at the contract instance level and is automatically refreshed when the contract is invoked. It does not require per-key `extend_ttl` calls.

## Storage Types

| Type | Max TTL | Use Case | extend_ttl Required? |
|---|---|---|---|
| `Instance` | Indefinite | Config (Admin, Token, Fee, Signers) | No — bundled with instance TTL |
| `Persistent` | ~1 year | Trade state, arbitrator membership, dispute records, reputation | Yes — on every active write |
| `Temporary` | ~30 days | Ephemeral caches, proof verification results | Yes — on every active write |

## TTL Extension Strategy in Velo

All contracts use `TTL_EXTEND = 100_000` ledgers (~5.8 days at ~5s/ledger) for persistent entries. This value is chosen to:

1. Cover the full lifecycle of a typical trade (lock → release/refund → observation)
2. Allow dispute resolution windows to play out without the trade or dispute record being archived
3. Keep reputation-scanner access to `TradeCounter` and `TradeId` entries
4. Provide enough runway for off-chain relayers and indexers to observe terminal events

## Audit Findings: Missing `extend_ttl` Calls

The following locations were found missing `extend_ttl` calls on persistent keys during active interactions and have been patched:

### Escrow (`contracts/escrow/src/lib.rs`)

| Function | Key(s) Patched |
|---|---|
| `lock` | `TradeCounter`, `TradeId` |
| `release` | `Trade` |
| `refund` | `Trade` |
| `raise_dispute` | `Trade`, `Dispute` |
| `resolve_dispute` | `Trade` |
| `fallback_after_timeout` | `Trade` |
| `batch_release` | `Trade` (per item) |
| `release_batch` | `Trade` (per item) |
| `release_escrow` | `Trade`, `Nonce` |
| `chain_release_to_lock` | `Trade` (released trade) |

### Atomic Swap (`contracts/atomic-swap/src/lib.rs`)

| Function | Key(s) Patched |
|---|---|
| `release` | `Trade` |
| `refund` | `Trade` |
| `extend_timelock_for_reorg` | `Trade` |

### Reputation (`contracts/reputation/src/lib.rs`)

| Function | Key(s) Patched |
|---|---|
| `initialize` | `Admin`, `EscrowContract` |
| `register_identity_root` | `VerifiedRoot` |
| `verify_provider_reputation` | `SpentNullifier` |
| `compute_score` | `CachedScore` |

### ZK Credential (`contracts/zk-credential/src/lib.rs`)

| Function | Key(s) Patched |
|---|---|
| `initialize` | `KnownRoots` |
| `buy_credential` | `Leaf`, `KnownRoots` |
| `spend_credential` | `Nullifier` |

## Best Practices

### When to call `extend_ttl`

- Call **after** every `env.storage().persistent().set()` during an active interaction.
- Call **after** reading and modifying a persistent entry (CEI pattern: set + extend before external calls).
- Do NOT call for read-only getter/view functions — they don't modify state.

### TTL values

- **Trade data** (`Trade`, `Dispute`, `DisputeSelection`, `Commitment`): `100_000` ledgers
- **Sequential index** (`TradeCounter`, `TradeId`): `100_000` ledgers
- **Reputation / identity** (`CachedScore`, `VerifiedRoot`, `SpentNullifier`): `100_000` ledgers
- **Proof cache** (`ProofCache`): `50_000`–`100_000` ledgers (shorter threshold, longer max)
- **Nonce tracking** (`Nonce`): `100_000` ledgers

### Monitoring

Monitor contract storage usage via Soroban RPC endpoints. A rapid increase in archived entries with active trades suggests TTL values may need adjustment.

## Cost Implications

Each `extend_ttl` call consumes Soroban resources (CPU instructions + storage fees). The `TTL_EXTEND = 100_000` value balances archival protection with cost:

- Extending an entry to 100_000 ledgers costs a fixed amount of gas per call
- The alternative — a client-facing transaction failing because a key was archived — is far more expensive in user trust and support burden
- Trade entries that reach a terminal state (`Released`, `Refunded`, `Resolved`) still get one final extension so off-chain observers can read the terminal state before archival
