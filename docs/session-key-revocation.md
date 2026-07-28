# Session Key Revocation Mechanism

## Overview

The session key implementation provides an instant, on-chain revocation mechanism that allows the main account to immediately invalidate any session key at any time. This is a critical security feature that ensures users can respond quickly to compromised keys or changing circumstances.

## Revocation Method

### Contract Function: `revoke_session_key`

The Soroban smart contract provides a `revoke_session_key` function that can only be called by the main account:

```rust
pub fn revoke_session_key(env: Env, session_key: Address) -> Result<(), Error> {
    let main_account: Address = env
        .storage()
        .instance()
        .get(&DataKey::MainAccount)
        .ok_or(Error::NotInitialized)?;

    // Only main account can revoke
    main_account.require_auth();

    let key = DataKey::SessionKey(session_key.clone());
    let mut session_info: SessionKeyInfo = env
        .storage()
        .instance()
        .get(&key)
        .ok_or(Error::SessionKeyNotFound)?;

    session_info.active = false;
    env.storage().instance().set(&key, &session_info);

    env.events()
        .publish((Symbol::new(&env, "session_key_revoked"),), session_key);

    Ok(())
}
```

### Key Security Properties

1. **Authorization**: Only the main account can call `revoke_session_key` due to the `main_account.require_auth()` check. This ensures that even if a session key is compromised, it cannot revoke itself or other keys.

2. **Immediate Effect**: Revocation sets the `active` flag to `false` in the contract's storage. The next authorization check for that session key will fail immediately.

3. **On-Chain Verification**: The revocation is recorded on-chain with an event emission, providing an auditable trail.

4. **Irreversible**: Once revoked, a session key cannot be reactivated. A new session key must be created if needed.

## Authorization Enforcement

The `check_auth_with_signer` function enforces the revocation status:

```rust
pub fn check_auth_with_signer(
    env: Env,
    signer: Address,
    amount: i128,
) -> Result<(), soroban_sdk::Error> {
    // ... main account check ...

    let session_info: SessionKeyInfo = match env.storage().instance().get(&key) {
        Some(info) => info,
        None => return Err(soroban_sdk::Error::from_contract_error(Error::UnauthorizedSigner as u32)),
    };

    // Check if session key is active
    if !session_info.active {
        return Err(soroban_sdk::Error::from_contract_error(Error::SessionKeyInactive as u32));
    }

    // ... spending cap and time window checks ...
}
```

When a session key is revoked, any subsequent authorization attempt will fail with `Error::SessionKeyInactive`.

## API Integration

The API provides both custodial and non-custodial endpoints for revocation:

### Custodial (Testnet Only)

```typescript
POST /api/v1/session/keys/revoke
{
  "session_key": "G...",
  "mode": "custodial"
}
```

The API signs and submits the transaction using the backend-held key (testnet only).

### Non-Custodial (Mainnet Ready)

```typescript
POST /api/v1/session/keys/revoke
{
  "session_key": "G...",
  "mode": "non_custodial",
  "signer_public_key": "G..."
}
```

The API returns an unsigned XDR that the client must sign with the main account's private key:

```typescript
{
  "unsigned_xdr": "...",
  "contract_id": "...",
  "instructions": "Sign this transaction with your main account to revoke the session key."
}
```

The client then signs and submits via:

```typescript
POST /api/v1/session/submit
{
  "signed_xdr": "..."
}
```

## Security Considerations

### Why Revocation is Critical

1. **Compromise Response**: If a session key is leaked or compromised, the main account can immediately invalidate it, limiting potential damage.

2. **Changing Circumstances**: Users may want to revoke keys when:
   - A service provider relationship ends
   - Spending limits need to be adjusted downward
   - Time windows need to be shortened
   - Security policies change

3. **Defense in Depth**: Revocation provides an additional layer of security beyond spending caps and time windows.

### Limitations

1. **No Retroactive Effect**: Revocation only prevents future authorizations. Transactions already submitted but not yet confirmed may still succeed if they were authorized before revocation.

2. **Requires Main Account**: Only the main account can revoke keys. If the main account's private key is lost, revocation becomes impossible (this is a general limitation of any cryptographic system).

3. **Gas Costs**: Each revocation transaction incurs Stellar network fees, though these are minimal.

## Best Practices

1. **Monitor Events**: Applications should listen for `session_key_revoked` events to update UI state and notify users.

2. **Graceful Degradation**: Client applications should handle revocation errors gracefully, informing users that their session key has been revoked and they may need to create a new one.

3. **Audit Trail**: Maintain off-chain records of revocation events for compliance and debugging purposes.

4. **Key Rotation**: Consider implementing policies for periodic key rotation, especially for long-lived session keys.

## Testing

The contract includes comprehensive tests for revocation:

```rust
#[test]
fn test_revocation_prevents_authorization() {
    // ... setup ...
    
    // Authorization should succeed initially
    SessionAccount::check_auth_with_signer(env.clone(), session_key.clone(), 10_000_000).unwrap();

    // Revoke the session key
    SessionAccount::revoke_session_key(env.clone(), session_key.clone()).unwrap();

    // Authorization should now fail
    let result = SessionAccount::check_auth_with_signer(env.clone(), session_key.clone(), 10_000_000);
    assert!(result.is_err());
}
```

This test verifies that:
1. A session key can authorize transactions before revocation
2. Revocation succeeds when called by the main account
3. Post-revocation authorization attempts fail

## Conclusion

The revocation mechanism provides a robust, on-chain-enforced way to invalidate session keys instantly. Combined with spending caps and time windows, it gives users fine-grained control over their session key permissions while maintaining strong security guarantees.
