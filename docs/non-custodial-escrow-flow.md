# Non-Custodial Escrow Flow

## Overview

This document describes the non-custodial transaction signing flow for Velo's escrow operations. Previously, the API signed all escrow transactions using a backend-held key (a testnet-only shortcut). The new implementation supports both custodial (legacy) and non-custodial modes.

## Motivation

The custodial signing approach was a testnet-only shortcut that is not suitable for production:

- **Security risk:** Backend holds private keys
- **Custodial liability:** API signs on user's behalf
- **Regulatory concerns:** Non-compliant with non-custodial wallet standards
- **Mainnet incompatibility:** Explicitly blocked on mainnet

The non-custodial flow shifts signing responsibility to the user's wallet, with the API only building and submitting transactions.

## Architecture

### Custodial Flow (Legacy)

```
User → API → Signs with backend key → Stellar Network
```

### Non-Custodial Flow (New)

```
User → API → Builds unsigned XDR → User Wallet
User Wallet → Signs XDR → API → Submits to Stellar Network
```

## API Changes

### POST /api/v1/cash/request

**New Request Parameter:**
- `mode`: `"custodial"` | `"non_custodial"` (default: `"custodial"`)

**Custodial Mode Response (unchanged):**
```json
{
  "claim_url": "https://app.velo.cash/claim/{tradeId}",
  "qr_payload": "velo://claim?request_id={tradeId}&contract={contractId}",
  "instructions": "Show this QR to the cash provider to receive your cash."
}
```

**Non-Custodial Mode Response (new):**
```json
{
  "request_id": "{tradeId}",
  "unsigned_xdr": "AAAA...base64 encoded XDR...",
  "network_passphrase": "Test SDF Network ; September 2015",
  "submit_url": "/api/v1/cash/request/{tradeId}/submit",
  "claim_url": "https://app.velo.cash/claim/{tradeId}",
  "qr_payload": "velo://claim?request_id={tradeId}&contract={contractId}",
  "instructions": "Sign the transaction with your wallet and submit to the provided endpoint."
}
```

### POST /api/v1/cash/request/:id/submit (New Endpoint)

**Request Body:**
```json
{
  "signed_xdr": "AAAA...base64 encoded signed XDR..."
}
```

**Response:**
```json
{
  "id": "{tradeId}",
  "status": "locked",
  "transaction_hash": "{stellar_tx_hash}",
  "claim_url": "https://app.velo.cash/claim/{tradeId}",
  "qr_payload": "velo://claim?request_id={tradeId}&contract={contractId}",
  "instructions": "Show this QR to the cash provider to receive your cash."
}
```

## Implementation Details

### Stellar Library Changes

**New Functions in `apps/api/src/lib/stellar.ts`:**

1. `buildLockEscrowTransaction(params)` - Builds unsigned lock transaction XDR
2. `buildReleaseEscrowTransaction(params)` - Builds unsigned release transaction XDR
3. `buildRefundEscrowTransaction(params)` - Builds unsigned refund transaction XDR
4. `submitSignedTransaction(signedXdr)` - Submits signed XDR to Stellar network

**Updated Functions:**
- `LockParams` interface now accepts optional `signerPublicKey` for non-custodial mode
- Existing `lockEscrow()`, `releaseEscrow()`, `refundEscrow()` functions remain unchanged

### Store Changes

**Updated Status Values in `apps/api/src/lib/store.ts`:**
- Added `"pending_signature"` status for non-custodial transactions awaiting user signature

### Route Changes

**Updated `apps/api/src/routes/cash.ts`:**
- Added `mode` parameter validation
- Conditional logic for custodial vs non-custodial flows
- New `/submit` endpoint for signed XDR submission

## Client Integration Guide

### Non-Custodial Flow

1. **Request unsigned transaction:**
   ```typescript
   const response = await fetch('/api/v1/cash/request', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       seller: 'GSELLER...',
       buyer: 'GBUYER...',
       amount_stroops: '10000000',
       secret_hash: '64-char-hex-string',
       mode: 'non_custodial'
     })
   });
   const { unsigned_xdr, network_passphrase, submit_url } = await response.json();
   ```

2. **Sign with user's wallet:**
   ```typescript
   const signedTx = await wallet.signTransaction(unsigned_xdr, {
     networkPassphrase: network_passphrase
   });
   const signedXdr = signedTx.toXDR();
   ```

3. **Submit signed transaction:**
   ```typescript
   const result = await fetch(submit_url, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ signed_xdr: signedXdr })
   });
   const { transaction_hash, claim_url } = await result.json();
   ```

### Custodial Flow (Legacy)

The existing flow remains unchanged for backward compatibility:

```typescript
const response = await fetch('/api/v1/cash/request', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    seller: 'GSELLER...',
    buyer: 'GBUYER...',
    amount_stroops: '10000000',
    secret_hash: '64-char-hex-string',
    // mode defaults to 'custodial'
  })
});
```

## Security Considerations

1. **No private keys on backend:** Non-custodial mode eliminates backend key storage
2. **User control:** Users sign transactions with their own wallets
3. **Transaction integrity:** XDR is built and simulated server-side before signing
4. **Network passphrase:** Explicitly provided to prevent signing on wrong network
5. **Status tracking:** `pending_signature` status prevents double-submission

## Migration Guide

### For Existing Clients

No changes required - custodial mode remains the default.

### For New Non-Custodial Clients

1. Add `mode: "non_custodial"` to request body
2. Handle unsigned XDR response
3. Integrate wallet signing flow
4. Submit signed XDR to `/submit` endpoint

### For Mainnet Deployment

- **Required:** Use non-custodial mode (custodial mode blocked on mainnet)
- **Required:** Ensure user wallets support Soroban transaction signing
- **Recommended:** Implement proper error handling for signing failures

## Testing

Added tests in `apps/api/src/routes/cash.test.ts`:
- Mode parameter validation
- Non-custodial request structure validation
- Submit endpoint validation

Note: Full integration tests require Stellar testnet RPC access and are recommended for pre-deployment validation.

## Future Enhancements

1. Add support for non-custodial release and refund operations
2. Implement transaction expiration for pending_signature status
3. Add webhook support for transaction status updates
4. Consider adding SEP-7/SEP-10 wallet integration standards

## References

- Original TODO comment in `apps/api/src/lib/stellar.ts` (lines 23-27)
- Stellar SDK documentation: https://stellar.github.io/js-stellar-sdk/
- Soroban documentation: https://soroban.stellar.org/
