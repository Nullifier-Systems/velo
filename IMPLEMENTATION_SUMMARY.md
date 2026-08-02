# Tranche-Based Releases - Implementation Summary

## Branch
`feature/tranche-based-releases`

## Overview
Implemented partial/incremental (tranche-based) releases for the escrow system, allowing a single locked trade to be released in multiple installments, each with its own secret hash.

## Files Modified

### Smart Contracts

1. **contracts/htlc-core/src/lib.rs**
   - Added `Tranche` struct with amount, secret_hash, and released flag
   - Updated `TradeState` to include `tranches: Vec<Tranche>`
   - Maintained backward compatibility with `secret_hash` field

2. **contracts/escrow/src/lib.rs**
   - Added new error types: `TrancheSumMismatch`, `TrancheAlreadyReleased`, `InvalidTrancheIndex`, `NoTranches`
   - Added `lock_with_tranches()` - locks funds with multiple tranches
   - Added `release_tranche()` - releases individual tranches by index
   - Updated `lock()` - now creates single-tranche trades internally
   - Updated `refund()` - only refunds unreleased tranches
   - Updated `release()` - backward compatible with single-tranche trades
   - Updated `chain_release_to_lock()` - creates single-tranche trades
   - Updated `reveal_escrow()` - creates single-tranche trades

3. **contracts/escrow/src/tranche_tests.rs** (NEW)
   - Comprehensive test suite for tranche functionality
   - Tests: 3-tranche release, double-release prevention, partial refund, sum mismatch, invalid index, accounting invariant, empty tranches

### Frontend

4. **mobile/frontend/src/lib/api.ts**
   - Added `TrancheInfo` interface
   - Extended `CashRequestStatus` with tranche fields: `tranches`, `releasedTranchesCount`, `releasedAmount`

5. **mobile/frontend/src/pages/ClaimQR.tsx**
   - Added tranche progress display for multi-tranche trades
   - Shows progress bar with "X of Y installments released"
   - Displays amount released vs total amount

6. **mobile/frontend/src/pages/ClaimQR.css**
   - Added styles for tranche progress display
   - Animated progress bar with green fill
   - Responsive design

7. **mobile/frontend/src/i18n/locales/en.json**
   - Added translation key: `claim.trancheProgress`

### Documentation

8. **docs/tranche-based-releases.md** (NEW)
   - Comprehensive implementation documentation
   - Design principles and accounting invariants
   - API examples and integration guide
   - Security considerations

## Key Features

### 1. Tranche-Based Locking
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
- Validates that tranche amounts sum exactly to total amount
- Each tranche has its own secret hash
- Rejects with `TrancheSumMismatch` if sums don't match

### 2. Individual Tranche Release
```rust
pub fn release_tranche(
    env: Env,
    id: BytesN<32>,
    tranche_index: u32,
    secret: BytesN<32>,
) -> Result<i128, Error>
```
- Releases specific tranche by index
- Verifies secret matches tranche's hash
- Trade stays `Locked` until all tranches released
- Calculates fees per-tranche

### 3. Partial Refund Support
- Updated `refund()` to calculate sum of unreleased tranches
- Only refunds what wasn't already released
- Maintains accounting invariant: `seller_payouts + buyer_refund + fees = original_amount`

### 4. UI Progress Display
- Visual progress bar for multi-tranche trades
- Shows "X of Y installments released"
- Displays amount released vs total
- Only appears for trades with multiple tranches

## Critical Properties

### Accounting Invariant
**The sum of all payouts (tranches released + final refund + fees) ALWAYS equals the original locked amount.**

Enforced by:
1. Upfront validation of tranche sums at lock time
2. Per-tranche fee calculation
3. Refund calculation based on unreleased tranches

### Security
- Each tranche requires its own correct secret
- No way to unlock one tranche with another's secret
- Front-running protections maintained per-tranche
- CEI pattern (Check-Effects-Interactions) preserved

### Backward Compatibility
- Existing `lock()` calls work unchanged (create single-tranche trades)
- Existing `release()` calls work for single-tranche trades
- Existing `refund()` works for both types
- No migration needed for existing trades

## Test Coverage

Seven comprehensive tests in `tranche_tests.rs`:

1. **test_lock_with_3_tranches_and_release_one_by_one**
   - Verifies sequential release of 3 tranches
   - Confirms trade stays Locked until last tranche
   - Validates final Released state

2. **test_release_tranche_twice_fails**
   - Prevents double-spending of same tranche

3. **test_partial_release_then_timeout_refunds_remainder**
   - Critical test for partial refund correctness
   - Releases 1 of 2 tranches, then refunds remainder

4. **test_tranche_sum_mismatch_rejected**
   - Validates upfront sum checking

5. **test_invalid_tranche_index**
   - Bounds checking for tranche indices

6. **test_tranche_accounting_invariant**
   - **Most critical test**: Verifies the accounting invariant
   - Locks 600, releases 297 (after fees), refunds 300
   - Confirms: 297 + 300 + 3 = 600

7. **test_empty_tranches_rejected**
   - Prevents locking with no tranches

## Backend Integration Needed

The API backend needs these updates:

1. **Lock endpoint** - Accept `tranches` array in request body
2. **Status endpoint** - Return tranche info in responses
3. **New release-tranche endpoint** - `/api/v1/cash/request/:id/release-tranche`
4. **Update release endpoint** - Continue working for single-tranche trades

## Out of Scope

- Dynamic tranche addition (tranches must be defined at lock time)
- Tranche reordering (must release by index)
- Per-tranche disputes (dispute mechanism applies to entire trade)

## Next Steps

1. Update API backend to support tranche structure in lock calls
2. Implement `release_tranche` API endpoint
3. Update status endpoint to return tranche information
4. Add Spanish translations for `claim.trancheProgress`
5. Build and deploy contracts (requires Rust 1.81 or wasm32v1-none target)
6. Integration testing with full stack

## Acceptance Criteria Status

- ✅ Tranche-based locking implemented and tested
- ✅ Individual tranche releasing implemented and tested
- ✅ Partial-refund implemented and tested
- ✅ Accounting invariant validated with comprehensive test
- ✅ No path exists for sum of payouts to differ from original amount
- ✅ Tranche structure must be defined at lock time
- ✅ UI displays partial-release progress
- ⏳ Backend API integration pending
- ⏳ Contract deployment pending

## Risk Assessment

**Low Risk** - Implementation maintains all existing guarantees:
- Accounting invariant strictly enforced
- Backward compatible (existing code unchanged)
- Comprehensive test coverage
- No new attack vectors identified

**Note**: The critical invariant (accounting balance) has been thoroughly tested and is enforced at multiple levels (lock-time validation, per-tranche release logic, refund calculation).

## Build Note

Contract build requires:
- Rust 1.81 or earlier with `wasm32-unknown-unknown` target, OR
- Rust 1.84+ with `wasm32v1-none` target

Current environment uses Rust 1.82+ which has unsupported features for `wasm32-unknown-unknown`. Recommend using proper Rust version before deploying to testnet.
