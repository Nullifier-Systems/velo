# Native Soroban Contract Upgrade Guide

## Quick Start

The escrow contract supports safe, timelocked upgrades using Soroban's native `update_current_contract_wasm()` mechanism.

### Upgrade Workflow

```
1. announce_upgrade(new_wasm_hash)  →  Records hash, starts timelock
                                        ↓ (~7 days)
2. Review period                    →  Operators verify new Wasm
                                        ↓ (timelock expires)
3. execute_upgrade(new_wasm_hash)   →  Hot-swaps Wasm, keeps all storage
```

### Why the Timelock?

Without a timelock, an admin could:
1. Deploy malicious Wasm instantly
2. Users with locked trades have no warning
3. Funds could be stolen before anyone notices

With the 7-day timelock:
1. Upgrade announcement is PUBLIC (emits event)
2. Operators fetch and review the new Wasm
3. Users can see what's coming and exit if they distrust it
4. Community can flag problems before execution
5. Admin can cancel if issues are found

## For Contract Operators

### Announcing an Upgrade

```rust
use soroban_sdk::{BytesN, Env};

// 1. Build and hash the new Wasm
let new_wasm: Vec<u8> = std::fs::read("new_escrow.wasm")?;
let hash = sha256(&new_wasm); // SHA-256

// 2. Announce the upgrade
client.announce_upgrade(
    &BytesN::from_array(&env, &hash),
    &admin_signers, // Single admin or multisig
);

// Event emitted: upgrade_announced(hash, executable_at_ledger)
```

### Monitoring for Announcements

Backend services should poll for pending upgrades:

```rust
if let Some(pending) = client.get_pending_upgrade() {
    eprintln!(
        "⚠️  UPGRADE ANNOUNCED\n\
         Hash: {:?}\n\
         Executable at ledger: {}\n\
         Time remaining: ~{} hours",
        pending.new_wasm_hash,
        pending.executable_at,
        (pending.executable_at - current_ledger) * 5 / 3600,
    );
}
```

### Reviewing the New Wasm

During the timelock period:

1. **Obtain the Wasm binary** that hashes to `new_wasm_hash`
2. **Verify the source** (Git commit, build reproducibility)
3. **Audit for storage compatibility:**
   - Are `TradeState` fields unchanged?
   - Are `DataKey` enum variants unchanged?
   - Are new fields optional/defaulted?
4. **Test on a fork** of mainnet with real storage
5. **Check for security issues** (new attack vectors?)

Use the [Storage Compatibility Checklist](./contract-upgrade-safety.md#storage-layout-compatibility-checklist) as a guide.

### Executing the Upgrade

After the timelock expires:

```rust
client.execute_upgrade(
    &BytesN::from_array(&env, &hash), // Must match announced hash
    &admin_signers,
);

// Event emitted: upgrade_executed(hash)
```

**This is irreversible.** The old Wasm is gone. The only way to roll back is to perform another upgrade back to the old Wasm hash.

### Cancelling an Upgrade

If you find a problem during the review period:

```rust
client.cancel_upgrade(&admin_signers);

// Event emitted: upgrade_cancelled(hash)
```

## For Contract Developers

### Adding Features Safely

#### ✅ Safe: Adding a New Admin Function

```rust
// In the NEW Wasm, add:
pub fn set_max_trade_amount(env: Env, max: i128, signers: Vec<Address>) {
    require_multisig(&env, &signers)?;
    env.storage().instance().set(&DataKey::MaxTradeAmount, &max);
}
```

**Why it's safe:**
- No existing `DataKey` variants affected
- `TradeState` unchanged
- Old trades never wrote `MaxTradeAmount`, so it's `None` for them

#### ❌ UNSAFE: Changing TradeState Field Order

```rust
// OLD Wasm
pub struct TradeState {
    pub seller: Address,
    pub buyer: Address,
    pub amount: i128,
    pub secret_hash: BytesN<32>,
    pub timeout_ledger: u32,
    pub status: TradeStatus,
}

// NEW Wasm (BREAKS STORAGE)
pub struct TradeState {
    pub buyer: Address,   // ❌ Swapped!
    pub seller: Address,  // ❌ Swapped!
    pub amount: i128,
    pub secret_hash: BytesN<32>,
    pub timeout_ledger: u32,
    pub status: TradeStatus,
}
```

**Effect:**
- Existing locked trades will deserialize with buyer/seller swapped
- Funds will be sent to the wrong party
- **Critical data corruption**

### Testing Your Changes

Before announcing an upgrade:

```rust
#[test]
fn upgrade_preserves_locked_trade() {
    // 1. Deploy OLD Wasm
    let old_contract = deploy_old_wasm(&env);
    
    // 2. Lock a trade
    let trade_id = old_contract.lock(buyer, seller, amount, hash, timeout);
    let before = old_contract.get_trade(&trade_id).unwrap();
    
    // 3. Simulate upgrade to NEW Wasm
    env.deployer().update_current_contract_wasm(new_wasm_hash);
    
    // 4. Verify trade is still readable
    let after = new_contract.get_trade(&trade_id).unwrap();
    assert_eq!(before, after);
    
    // 5. Verify trade is still releasable
    new_contract.release(&trade_id, &secret);
    assert_eq!(new_contract.get_trade(&trade_id).unwrap().status, TradeStatus::Released);
}
```

## For Users

### What Happens to My Locked Trade?

When the contract is upgraded:
- ✅ Your trade ID stays the same
- ✅ Your funds stay locked under the same secret hash
- ✅ The timeout is unchanged
- ✅ You can still release or refund as before

**The contract address never changes.** This is a Wasm hot-swap, not a redeployment.

### How to Monitor Upgrades

Watch for the `upgrade_announced` event:

```rust
// Event structure
topic: ["upgrade_announced"]
data: (BytesN<32> new_wasm_hash, u32 executable_at_ledger)
```

If you see this and distrust the upcoming upgrade:
1. Check the time remaining: `(executable_at - current_ledger) * 5` seconds
2. Release your trade before the upgrade executes (if you have the secret)
3. Or wait for timeout and refund

### Can an Upgrade Steal My Funds?

**With the timelock: unlikely.** You have ~7 days to notice and exit.

**Without the timelock: yes.** An instant upgrade could deploy malicious code that redirects funds. That's why we use the timelock.

### What If I Miss the Announcement?

The `get_pending_upgrade()` query is public. Check it yourself:

```bash
# Using soroban CLI
soroban contract invoke \
  --id <CONTRACT_ID> \
  --fn get_pending_upgrade

# Returns: Some(UpgradeAnnouncement { ... }) or None
```

## Rollback Procedure

If an upgrade causes problems after execution:

```rust
// 1. Immediately announce a rollback to the OLD Wasm hash
client.announce_upgrade(&old_wasm_hash, &admin_signers);

// 2. Wait for the timelock (cannot be skipped!)
// ... ~7 days ...

// 3. Execute the rollback
client.execute_upgrade(&old_wasm_hash, &admin_signers);
```

**Note:** The timelock applies to rollbacks too. If the bug is critical, you may need to pause the contract while waiting for the rollback timelock.

## Advanced: Multisig Upgrades

In multisig mode, upgrades require threshold signatures:

```rust
// Announce with 2-of-3 signers
let signers = vec![signer1, signer2]; // >= threshold
client.announce_upgrade(&new_hash, &signers);

// Execute with a different 2-of-3 combination
let signers = vec![signer2, signer3];
client.execute_upgrade(&new_hash, &signers);
```

## Event Reference

### `upgrade_announced`
```rust
topic: ["upgrade_announced"]
data: (BytesN<32> new_wasm_hash, u32 executable_at_ledger)
```
Emitted when admin calls `announce_upgrade()`.

### `upgrade_executed`
```rust
topic: ["upgrade_executed"]
data: BytesN<32> new_wasm_hash
```
Emitted when `execute_upgrade()` succeeds. The Wasm swap is now active.

### `upgrade_cancelled`
```rust
topic: ["upgrade_cancelled"]
data: BytesN<32> cancelled_wasm_hash
```
Emitted when `cancel_upgrade()` is called during the timelock period.

## FAQ

**Q: Why 7 days? That's a long time if there's a critical bug.**
A: The timelock protects users from instant malicious upgrades. For critical bugs, use the `pause()` circuit breaker to stop new locks while you prepare a proper upgrade.

**Q: Can I shorten the timelock?**
A: Yes, by changing `UPGRADE_TIMELOCK_LEDGERS` in the contract code. But this requires an upgrade (with the old timelock) to take effect. Default is 7 days for safety.

**Q: What if the admin key is compromised?**
A: An attacker can announce a malicious upgrade, but they still have to wait the full timelock. Users have ~7 days to notice and withdraw funds. After that, migrate to a contract with a new admin or multisig.

**Q: Can I upgrade to a completely different contract (different storage schema)?**
A: No. The upgrade mechanism is for hot-swapping compatible Wasm only. If you need to change storage layout fundamentally, deploy a new contract and migrate funds via a controlled process.

**Q: Does this work with the existing `pause` circuit breaker?**
A: Yes. If a bad upgrade goes through, you can immediately `pause()` to stop new locks while preparing a rollback upgrade.

## Resources

- [Full Upgrade Safety Documentation](./contract-upgrade-safety.md) - Complete technical guide
- [Implementation Status](./UPGRADE_IMPLEMENTATION_STATUS.md) - Current progress and known issues
- [Soroban Upgrade Documentation](https://soroban.stellar.org/docs/learn/contract-upgradability) - Official Soroban docs

## Summary

The native upgrade mechanism provides a balance between:
- **Flexibility:** Admins can fix bugs and add features without redeploying
- **Safety:** Users have warning and time to exit if they distrust an upgrade
- **Persistence:** Existing trades survive upgrades with the same semantics

Use it responsibly, test thoroughly, and respect the timelock.
