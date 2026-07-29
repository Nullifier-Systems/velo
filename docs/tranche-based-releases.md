# Tranche-Based Releases Implementation

## Overview

This document describes the implementation of partial/incremental (tranche-based) releases for the Velo escrow system. This feature allows a single locked trade to be released in multiple installments, each independently secured by its own secret, while maintaining the same overall trustless guarantee for every tranche.

## Motivation

Real-world cash hand-offs sometimes happen in installments. For example:
- A provider hands over half the cash now, half in ten minutes because that's what they have on hand
- Staged deliveries where verification happens between installments
- Risk mitigation for large amounts by splitting into smaller releases

The existing `release()` function was all-or-nothing — the full locked amount went to the seller in one shot, triggered by one secret. This implementation adds support for multiple independent releases per trade.

## Core Design Principle

**The dangerous part of this feature isn't releasing a tranche — it's making sure the accounting across every tranche, plus whatever's left over for a refund, always adds up to exactly the original locked amount.**

### Accounting Invariant

```
seller_payouts + buyer_refund + total_fees = original_locked_amount
```

This invariant must hold for every execution path:
- Full release (all tranches released)
- Partial release + refund (some tranches released, timeout, refund remainder)
- No release + refund (no tranches released, timeout, refund all)

## Contract Changes

### Core Type Changes (`htlc-core`)

```rust
/// A single tranche within a trade
#[derive(Clone)]
#[contracttype]
pub struct Tranche {
    pub amount: i128,
    pub secret_hash: BytesN<32>,
    pub released: bool,
}

#[derive(Clone)]
#[contracttype]
pub struct TradeState {
    pub seller: Address,
    pub buyer: Address,
    /// Total locked amount across all tranches (immutable)
    pub amount: i128,
    /// List of tranches, each with its own amount and secret hash
    pub tranches: Vec<Tranche>,
    pub timeout_ledger: u32,
    pub status: TradeStatus,
    /// For backward compatibility: single secret_hash field
    pub secret_hash: BytesN<32>,
}
```

### New Error Types

```rust
/// Tranche amounts don't sum to the total locked amount
TrancheSumMismatch = 31,
/// Attempted to release a tranche that was already released
TrancheAlreadyReleased = 32,
/// Invalid tranche index (out of bounds)
InvalidTrancheIndex = 33,
/// Tranches array is empty
NoTranches = 34,
```

### New Contract Functions

#### `lock_with_tranches()`

Locks funds with multiple tranches, each with its own secret hash.

```rust
pub fn lock_with_tranches(
    env: Env,
    id: BytesN<32>,
    seller: Address,
    buyer: Address,
    amount: i128,
    tranches: Vec<Tranche>,
    timeout_ledgers: u32,
) -> Result<(), Error>
```

**Critical validation**: The sum of all tranche amounts MUST equal the total `amount` parameter. Rejects with `TrancheSumMismatch` if not.

#### `release_tranche()`

Releases a specific tranche by index, revealing its secret.

```rust
pub fn release_tranche(
    env: Env,
    id: BytesN<32>,
    tranche_index: u32,
    secret: BytesN<32>,
) -> Result<i128, Error>
```

**Behavior**:
- Verifies the secret matches the tranche's hash
- Marks the tranche as `released`
- Transfers the tranche's amount (minus fee) to the seller
- If all tranches are now released, marks the entire trade as `Released`
- Returns the payout amount

**State transitions**:
- Trade remains `Locked` until ALL tranches are released
- Only when the last tranche is released does the trade become `Released`
- Bond refund (Issue #280) happens only on full release

### Modified Functions

#### `lock()`

Updated to create a single-tranche trade for backward compatibility. The existing API continues to work unchanged — single-secret trades are now just trades with one tranche.

```rust
fn lock(
    env: Env,
    id: BytesN<32>,
    seller: Address,
    buyer: Address,
    amount: i128,
    secret_hash: BytesN<32>,
    timeout_ledgers: u32,
)
```

Creates a `TradeState` with a single tranche containing the full amount.

#### `refund()`

Updated to only refund unreleased tranches:

```rust
fn refund(env: Env, id: BytesN<32>)
```

**New behavior**:
1. Calculates the sum of all unreleased tranches
2. Transfers only that amount to the buyer
3. Marks the trade as `Refunded`

**Critical property**: If some tranches were already released, the seller keeps those payouts and the buyer only gets back the unreleased remainder.

#### `release()`

Updated for backward compatibility with single-tranche trades. Multi-tranche trades must use `release_tranche()`.

## Test Coverage

Comprehensive tests in `contracts/escrow/src/tranche_tests.rs`:

### 1. Three Tranches, Released One by One
- Locks 500 in three tranches (200, 150, 150)
- Releases each individually
- Verifies trade stays `Locked` until the last one
- Verifies fees calculated per-tranche
- Confirms final state is `Released`

### 2. Double-Release Prevention
- Attempts to release the same tranche twice
- Verifies error: `TrancheAlreadyReleased`

### 3. Partial Release + Timeout Refund
- Locks 500 in two tranches (300, 200)
- Releases first tranche (300)
- Lets timeout pass
- Refunds remaining (200)
- **Critical test**: Verifies seller got 297 (300 - 1% fee) and buyer got back 200

### 4. Tranche Sum Mismatch Rejection
- Attempts to lock with tranches summing to 450 while claiming 500
- Verifies error: `TrancheSumMismatch`

### 5. Invalid Tranche Index
- Attempts to release tranche index out of bounds
- Verifies error: `InvalidTrancheIndex`

### 6. Accounting Invariant
- Locks 600 in three tranches (100, 200, 300)
- Releases first two (100, 200)
- Refunds remaining (300)
- **Critical verification**: `297 + 300 + 3 = 600`
  - Seller payouts: 99 + 198 = 297
  - Buyer refund: 300
  - Total fees: 1 + 2 = 3
  - Sum: 600 (original locked amount)

### 7. Empty Tranches Rejected
- Attempts to lock with empty tranches vector
- Verifies error: `NoTranches`

## Frontend Changes

### API Types (`mobile/frontend/src/lib/api.ts`)

```typescript
export interface TrancheInfo {
  amount: string;
  secretHashHex: string;
  released: boolean;
}

export interface CashRequestStatus {
  // ... existing fields ...
  tranches?: TrancheInfo[];
  releasedTranchesCount?: number;
  releasedAmount?: string;
}
```

### UI Updates (`mobile/frontend/src/pages/ClaimQR.tsx`)

Added tranche progress display for multi-tranche trades:

```tsx
{status.tranches && status.tranches.length > 1 && (
  <div className="claim-ticket__tranche-progress">
    <p className="claim-ticket__tranche-label">
      {t("claim.trancheProgress", { 
        released: status.releasedTranchesCount || 0, 
        total: status.tranches.length 
      })}
    </p>
    <div className="claim-ticket__tranche-bar">
      <div 
        className="claim-ticket__tranche-bar-fill"
        style={{ 
          width: `${((status.releasedTranchesCount || 0) / status.tranches.length) * 100}%` 
        }}
      />
    </div>
    {status.releasedAmount && (
      <p className="claim-ticket__tranche-amount">
        {formatStroops(status.releasedAmount)} / {formatStroops(status.amountStroops)} released
      </p>
    )}
  </div>
)}
```

**Visual design**:
- Progress bar showing `X of Y installments released`
- Fill bar animates as tranches are released
- Shows amount released vs total amount
- Only visible for multi-tranche trades

### Styling (`mobile/frontend/src/pages/ClaimQR.css`)

Added styles for tranche progress:
- `.claim-ticket__tranche-progress`: Container with subtle background
- `.claim-ticket__tranche-bar`: Progress bar track
- `.claim-ticket__tranche-bar-fill`: Animated fill (green)
- `.claim-ticket__tranche-amount`: Amount display in monospace font

### Localization

Added translation key in `mobile/frontend/src/i18n/locales/en.json`:

```json
"trancheProgress": "{{released}} of {{total}} installments released"
```

## Backend Integration

The API needs to:

1. **Provide tranche structure during lock** — The lock endpoint needs a way to specify tranches upfront (e.g., accept a `tranches` array in the request body)

2. **Return tranche info in status responses** — The `/api/v1/cash/request/:id` endpoint should include:
   - `tranches`: Array of tranche info
   - `releasedTranchesCount`: Count of released tranches
   - `releasedAmount`: Sum of released tranche amounts

3. **Add release_tranche endpoint** — New endpoint like `/api/v1/cash/request/:id/release-tranche` that accepts:
   - `tranche_index`: The index to release
   - `secret`: The secret for that tranche

4. **Update existing release endpoint** — The existing `/api/v1/cash/request/:id/release` should continue to work for single-tranche trades

## Security Considerations

### Trustless Guarantee Preserved

Each tranche has its own secret hash. A provider must reveal the correct secret for each tranche independently to receive that tranche's payout. There's no way to "unlock" one tranche using another tranche's secret.

### No Partial-Refund Griefing

The buyer can always reclaim unreleased tranches after timeout. If a provider releases some tranches and then disappears, the buyer gets back exactly what wasn't released — no funds are trapped.

### Front-Running Resistance

The existing front-running protections apply per-tranche:
- Each `release_tranche()` call checks the secret independently
- Status checks happen before secret verification
- CEI pattern (Check-Effects-Interactions) maintained

### Accounting Integrity

The critical invariant is enforced at lock time:
```rust
if tranche_sum != amount {
    return Err(Error::TrancheSumMismatch);
}
```

No code path can create or destroy funds because:
1. Lock validates the sum upfront
2. Releases transfer exactly tranche amounts (minus fees)
3. Refunds transfer exactly the sum of unreleased tranches
4. Fees are calculated per-tranche consistently

## Backward Compatibility

### Existing single-secret trades

All existing code continues to work:
- `lock()` creates a single-tranche trade internally
- `release()` works on single-tranche trades
- `refund()` works on both single and multi-tranche trades

### Migration path

No migration needed. Existing trades are unchanged. New trades can opt into tranches by calling `lock_with_tranches()`.

## Out of Scope

### Dynamic tranche addition

Tranches cannot be added after `lock()`. The full tranche structure must be defined upfront at lock time. This simplifies accounting and prevents griefing vectors.

### Tranche reordering

Tranches must be released by index. There's no mechanism to skip tranches or release them out of order. Each provider decides the order when structuring the trade.

### Dispute mechanism

The existing dispute mechanism (`raise_dispute`, `resolve_dispute`) applies to the entire trade, not individual tranches. An arbitrator resolves the full trade, they don't adjudicate individual installments.

## Events

New event emitted by `release_tranche()`:

```rust
env.events().publish(
    (symbol_short(&env, "tranche_rel"), id.clone()),
    (tranche_index, payout),
);
```

When all tranches are released, the standard `released` event is also emitted:

```rust
env.events().publish(
    (symbol_short(&env, "released"), id),
    state.amount
);
```

## API Example

### Lock with Tranches

```http
POST /api/v1/cash/lock
Content-Type: application/json

{
  "seller": "GXXXXXX...",
  "buyer": "GXXXXXX...",
  "amount": "500",
  "timeout_ledgers": 100,
  "tranches": [
    {
      "amount": "200",
      "secret_hash": "abcd1234..."
    },
    {
      "amount": "150",
      "secret_hash": "ef567890..."
    },
    {
      "amount": "150",
      "secret_hash": "12345678..."
    }
  ]
}
```

### Release Tranche

```http
POST /api/v1/cash/request/:id/release-tranche
Content-Type: application/json

{
  "tranche_index": 0,
  "secret": "secret_for_first_tranche"
}
```

### Get Status (with Tranches)

```http
GET /api/v1/cash/request/:id

Response:
{
  "id": "...",
  "status": "locked",
  "amountStroops": "5000000",
  "tranches": [
    {
      "amount": "2000000",
      "secretHashHex": "abcd1234...",
      "released": true
    },
    {
      "amount": "1500000",
      "secretHashHex": "ef567890...",
      "released": false
    },
    {
      "amount": "1500000",
      "secretHashHex": "12345678...",
      "released": false
    }
  ],
  "releasedTranchesCount": 1,
  "releasedAmount": "2000000"
}
```

## Future Enhancements

### Per-Tranche Timeouts

Each tranche could have its own timeout, allowing staged releases with escalating deadlines.

### Tranche Metadata

Tranches could carry metadata (memo, description) to help providers and buyers coordinate complex deliveries.

### Partial Disputes

The dispute mechanism could be extended to dispute individual tranches rather than the entire trade.

## Conclusion

This implementation adds powerful partial-release capabilities while:
- Preserving the existing trustless guarantee
- Maintaining backward compatibility
- Enforcing strict accounting invariants
- Providing clear UI feedback for multi-installment trades

The critical property — that funds can never be created, destroyed, or trapped — is maintained through upfront validation of tranche sums and careful per-tranche release logic.
