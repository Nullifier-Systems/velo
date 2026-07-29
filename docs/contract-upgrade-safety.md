# Contract Upgrade Safety

This document describes the safe upgrade procedure for the Soroban escrow contract using native Wasm hot-swapping.

## Overview

Soroban provides a native contract upgrade mechanism via the `update_current_contract_wasm()` host function. This atomically replaces the contract's executable code while preserving:
- The same contract address
- All existing storage entries at that address
- All ongoing trades and their state

**Critical property:** An upgrade is NOT deploying a new contract instance — it's hot-swapping the Wasm binary of an existing contract that may have active locked trades. If the new Wasm expects a different storage layout than the old one wrote, those trades become unreadable or corrupted.

## Upgrade Process

### 1. Announce Phase (`announce_upgrade`)

```rust
announce_upgrade(new_wasm_hash: BytesN<32>, signers: Vec<Address>) -> Result<(), Error>
```

- **Authorization:** Requires admin or multisig (same governance as `pause`, `set_platform_fee`, etc.)
- **What it does:** Records the SHA-256 hash of the new Wasm binary and sets an executable ledger `UPGRADE_TIMELOCK_LEDGERS` (≈7 days) in the future
- **Why the timelock:** Gives operators time to:
  - Fetch and review the Wasm binary that hashes to `new_wasm_hash`
  - Verify storage layout compatibility (see checklist below)
  - Alert users with active locked trades about the upcoming change
  - Cancel the upgrade if problems are discovered

**Events emitted:**
- `upgrade_announced(new_wasm_hash, executable_at_ledger)`

### 2. Review Period

During the timelock window, operators MUST:

1. **Obtain the new Wasm binary** whose SHA-256 hash matches `new_wasm_hash`
2. **Inspect the source code** (if available) or disassemble the Wasm
3. **Verify storage layout compatibility** using the checklist below
4. **Test the upgrade** on a testnet or mainnet fork with cloned state
5. **Monitor for existing locked trades** that would be affected

If any compatibility issue is found, call `cancel_upgrade()` before the timelock expires.

### 3. Execute Phase (`execute_upgrade`)

```rust
execute_upgrade(new_wasm_hash: BytesN<32>, signers: Vec<Address>) -> Result<(), Error>
```

- **Authorization:** Requires admin or multisig
- **Preconditions:**
  - An upgrade must have been announced via `announce_upgrade`
  - The timelock must have elapsed (`current_ledger >= executable_at_ledger`)
  - The `new_wasm_hash` passed here must exactly match the hash that was announced
- **What it does:** Calls `env.deployer().update_current_contract_wasm(new_wasm_hash)`, atomically replacing the contract's executable code
- **Irreversible:** Once executed, the old Wasm is gone. The only way to roll back is to perform another upgrade back to the old Wasm hash.

**Events emitted:**
- `upgrade_executed(new_wasm_hash)`

### 4. Cancel Phase (Optional, `cancel_upgrade`)

```rust
cancel_upgrade(signers: Vec<Address>) -> Result<(), Error>
```

- **Authorization:** Requires admin or multisig
- **What it does:** Removes the pending upgrade announcement before the timelock expires
- **Use case:** Aborting an upgrade after a compatibility issue or security flaw is discovered during the review period

**Events emitted:**
- `upgrade_cancelled(cancelled_wasm_hash)`

## Storage Layout Compatibility Checklist

The new Wasm MUST preserve the storage layout for all data structures that already exist in storage. Violating these rules will corrupt existing trades.

### ✅ Safe Changes (Compatible)

1. **Adding new contract functions** (e.g., a new admin-only setter, a new query method)
2. **Adding new `DataKey` enum variants** that don't overlap with existing ones
3. **Adding new fields to structs** IF those fields are:
   - Optional (`Option<T>`)
   - Have default values
   - AND the struct is only written by NEW code (not read from existing storage expecting the old layout)
4. **Changing internal function logic** without altering what gets written to storage
5. **Adding new constants** or helper functions

### ❌ Unsafe Changes (Storage-Incompatible)

1. **Changing the order of fields** in any `#[contracttype]` struct that's already stored:
   ```rust
   // OLD (existing storage)
   pub struct TradeState {
       pub seller: Address,
       pub buyer: Address,
       pub amount: i128,
       pub secret_hash: BytesN<32>,
       pub timeout_ledger: u32,
       pub status: TradeStatus,
   }

   // NEW (INCOMPATIBLE — field order changed)
   pub struct TradeState {
       pub buyer: Address,      // ❌ Swapped with seller
       pub seller: Address,      // ❌ Now in wrong position
       pub amount: i128,
       // ... rest unchanged
   }
   ```
   **Effect:** Existing locked trades will have `buyer` and `seller` swapped when deserialized, sending funds to the wrong party.

2. **Changing field types** in stored structs:
   ```rust
   // OLD
   pub amount: i128,

   // NEW (INCOMPATIBLE)
   pub amount: u64,  // ❌ Different type
   ```
   **Effect:** Deserialization will fail or produce garbage values.

3. **Renaming fields** in `#[contracttype]` structs (Soroban serialization is positional, but some tooling is name-aware)

4. **Removing fields** from structs that are read from storage:
   ```rust
   // OLD
   pub struct TradeState {
       pub seller: Address,
       pub buyer: Address,
       pub amount: i128,
       pub timeout_ledger: u32,  // ❌ Removed in new version
       pub status: TradeStatus,
   }
   ```
   **Effect:** Deserializing old `TradeState` entries will fail because the binary format expects 6 fields but finds 5.

5. **Changing `DataKey` enum discriminants** (reordering variants or inserting new ones in the middle):
   ```rust
   // OLD
   enum DataKey {
       Admin,           // discriminant 0
       Token,           // discriminant 1
       Trade(BytesN<32>), // discriminant 2
   }

   // NEW (INCOMPATIBLE — inserted NewKey in the middle)
   enum DataKey {
       Admin,           // still 0
       NewKey,          // ❌ Now 1, pushes everything down
       Token,           // ❌ Now 2 (was 1)
       Trade(BytesN<32>), // ❌ Now 3 (was 2)
   }
   ```
   **Effect:** Existing storage keys will be misinterpreted (a `Token` lookup will read `NewKey` data).

6. **Changing the semantics** of a stored field without changing its type:
   ```rust
   // OLD: amount in stroops
   pub amount: i128,

   // NEW: amount in XLM (1 XLM = 10^7 stroops)
   pub amount: i128,  // ❌ Same type, different meaning
   ```
   **Effect:** Existing trades will have their amounts misinterpreted by a factor of 10^7.

### Critical Structs to Preserve

These structs are directly read from storage and MUST remain layout-compatible:

1. **`TradeState`** (from `htlc-core` crate)
   ```rust
   pub struct TradeState {
       pub seller: Address,
       pub buyer: Address,
       pub amount: i128,
       pub secret_hash: BytesN<32>,
       pub timeout_ledger: u32,
       pub status: TradeStatus,
   }
   ```
   Stored under `DataKey::Trade(BytesN<32>)`. Thousands of these may exist at any time.

2. **`ArbitratorMeta`**
   ```rust
   pub struct ArbitratorMeta {
       pub joined_ledger: u32,
       pub active: bool,
       pub pending_disputes: u32,
   }
   ```
   Stored under `DataKey::ArbitratorMember(Address)`.

3. **`DisputeSelection`**
   ```rust
   pub struct DisputeSelection {
       pub raised_ledger: u32,
       pub reveal_ledger: u32,
       pub eligible: Vec<Address>,
       pub selected: Option<Address>,
   }
   ```
   Stored under `DataKey::DisputeSelection(BytesN<32>)`.

4. **`CommitmentState`** (MEV protection)
   ```rust
   pub struct CommitmentState {
       pub buyer: Address,
       pub collateral: i128,
       pub amount: i128,
       pub committed_at_ledger: u32,
       pub reveal_window_min_ledgers: u32,
       pub reveal_window_max_ledgers: u32,
   }
   ```
   Stored under `DataKey::Commitment(BytesN<32>)`.

5. **`BondParams`, `DynamicFeeConfig`, `ArbitratorSet`** — instance storage configs

## Testing Upgrades

### Unit Test Strategy

The `upgrade_test.rs` module verifies:
- Timelock enforcement (cannot execute before `UPGRADE_TIMELOCK_LEDGERS` elapse)
- Admin authorization (only admin/multisig can announce/execute)
- Hash matching (cannot substitute a different Wasm at execution time)
- State preservation (locked trades remain readable after upgrade simulation)

**Limitation:** Soroban SDK test utilities cannot actually compile and load multiple Wasm binaries in a single test, so we cannot test a real Wasm swap. The tests verify the upgrade mechanism's logic but not end-to-end storage compatibility.

### Integration Test Strategy (Testnet)

1. **Deploy the current version** of the contract to testnet
2. **Lock several trades** with different states: `Locked`, `Disputed`, `Released`, `Refunded`
3. **Build the new Wasm** with your proposed changes
4. **Announce the upgrade** with the new Wasm hash
5. **Wait for the timelock** to elapse (or manually advance ledgers in a local network)
6. **Execute the upgrade**
7. **Verify all existing trades** are still readable and their semantics are unchanged:
   - `get_trade()` returns correct data
   - `release()` still works with the correct secret
   - `refund()` still works after timeout
   - Disputed trades can still be resolved

### Mainnet Fork Testing

For production upgrades, test on a forked mainnet with cloned state:
1. Fork mainnet at the current ledger
2. Clone all contract storage (use Horizon or RPC to export storage entries)
3. Perform the upgrade on the fork
4. Verify all existing locked trades are still valid
5. Test at least one release, refund, and dispute resolution

## Rollback Procedure

If an upgrade causes problems in production:

1. **Immediately announce a rollback upgrade** with the OLD Wasm hash
2. **Wait for the timelock** (cannot be skipped — this is by design)
3. **Execute the rollback** upgrade

**Prevention is better than rollback:** The timelock exists specifically so you can catch problems BEFORE the upgrade executes. Use it.

## Monitoring

Off-chain systems should monitor the `get_pending_upgrade()` query and alert operators when an upgrade is announced:

```rust
let pending: Option<UpgradeAnnouncement> = client.get_pending_upgrade();
if let Some(announcement) = pending {
    log::warn!(
        "Upgrade announced: hash={}, executable_at_ledger={}",
        announcement.new_wasm_hash,
        announcement.executable_at,
    );
    // Alert operators for review
}
```

## Example Scenarios

### Scenario 1: Adding a New Admin Function (Safe)

**Change:** Add a `set_max_trade_amount()` function to enforce a per-trade cap.

**Why it's safe:**
- No existing storage entries are affected
- New function only writes a new `DataKey::MaxTradeAmount` entry
- `TradeState` layout unchanged

**Procedure:**
1. Build new Wasm with the added function
2. Announce upgrade
3. Review: verify no storage layout changes
4. Wait for timelock
5. Execute upgrade
6. Call the new function to set the max trade amount

### Scenario 2: Adding a Field to TradeState (UNSAFE)

**Change:** Add `pub fee_paid: i128` to `TradeState` to track fees separately.

**Why it's UNSAFE:**
- Existing `TradeState` entries in storage have 6 fields
- New code expects 7 fields
- Deserializing old entries will fail or read garbage

**Mitigation:**
1. Add a NEW storage key `DataKey::TradeFee(BytesN<32>)` instead of modifying `TradeState`
2. Old trades: `TradeFee` is `None`
3. New trades: `TradeFee` is `Some(amount)`

### Scenario 3: Fixing a Critical Bug (Safe, if done carefully)

**Change:** Fix a logic error in `resolve_dispute()` that miscalculates fee distribution.

**Why it's safe (if done right):**
- The fix only changes internal arithmetic, not storage layout
- `TradeState` structure unchanged
- Existing disputed trades can still be resolved with the corrected logic

**Procedure:**
1. Fix the bug in the code
2. Build new Wasm
3. Announce upgrade
4. Review: verify only logic changed, no storage format changes
5. Test on a fork with existing disputes
6. Execute upgrade
7. Existing disputes resolve with the corrected behavior

## Conclusion

Contract upgrades are powerful but dangerous. The timelock mechanism gives you one chance to catch a storage-incompatible upgrade before it corrupts every locked trade. Use that window to:
- **Audit the new Wasm thoroughly**
- **Test on a fork of production state**
- **Verify that existing trades survive the upgrade**

When in doubt, cancel the upgrade and add more safety checks to your review process.
