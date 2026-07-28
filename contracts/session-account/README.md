# Session Account Contract

A Soroban smart contract implementing a session key mechanism for Stellar. This contract allows users to pre-authorize a bounded set of future actions without requiring a full transaction signature for each operation.

## Features

- **Spending Caps**: Enforce maximum total amounts that session keys can authorize
- **Time Windows**: Define validity periods for session keys (start delay + duration)
- **Instant Revocation**: Immediately invalidate session keys when needed
- **On-Chain Enforcement**: All bounds are enforced by the Soroban contract, not just client-side
- **Non-Custodial**: Designed for mainnet with full client-side signing support

## Architecture

The contract acts as a custom account with a custom authorization hook (`check_auth_with_signer`) that enforces session key bounds before allowing any operation.

### Data Structures

- `MainAccount`: The primary account that owns the session account
- `SessionKey(Address)`: Session key information including spending cap, time window, and active status
- `Spent(Address)`: Track total amount authorized by each session key

## Contract Functions

### `initialize(main_account: Address)`
Initializes the session account with the main account address. Can only be called once.

### `create_session_key(session_key, spending_cap, duration_days, start_delay_days)`
Creates a new session key with specified bounds:
- `spending_cap`: Maximum total amount (in stroops)
- `duration_days`: Validity duration (max 30 days)
- `start_delay_days`: Delay before activation

### `revoke_session_key(session_key)`
Immediately invalidates a session key. Only callable by the main account.

### `update_spending_cap(session_key, new_spending_cap)`
Updates the spending cap of an existing session key. Only callable by the main account.

### `check_auth_with_signer(signer, amount)`
Authorization hook that enforces all bounds. Called automatically when the session account is used as a signer.

### View Functions

- `get_main_account()`: Returns the main account address
- `get_session_key(session_key)`: Returns session key information
- `get_spent(session_key)`: Returns total amount spent by a session key

## Building

```bash
cargo build --package session-account --release
```

## Testing

```bash
cargo test --package session-account
```

All tests demonstrate that bounds cannot be exceeded even if session keys are compromised:
- Spending cap enforcement
- Time window enforcement
- Revocation prevents authorization
- Main account always allowed

## Deployment

1. Build the contract:
```bash
soroban contract build
```

2. Deploy to Soroban network:
```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/session_account.wasm \
  --source <YOUR_SECRET_KEY> \
  --network testnet
```

3. Initialize with your main account:
```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source <MAIN_ACCOUNT_SECRET> \
  --network testnet \
  initialize \
  --main_account <MAIN_ACCOUNT_PUBLIC_KEY>
```

## Security Considerations

### On-Chain Enforcement

All bounds are enforced on-chain. Even if a session key is compromised, it cannot:
- Exceed its spending cap
- Authorize transactions outside its time window
- Authorize transactions after being revoked
- Revoke other session keys or itself

### Limitations

The current implementation uses a simplified authorization hook that accepts the signer address directly. For production use, this should be enhanced with:
- Full Ed25519 signature verification
- Dynamic amount parsing from the auth context
- Support for multiple main accounts per contract

## Documentation

- [Session Key Implementation Guide](../../docs/session-key-implementation.md)
- [Session Key Revocation Mechanism](../../docs/session-key-revocation.md)

## License

See project root for license information.
