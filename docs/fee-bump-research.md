# Fee-Bump Transactions Research

**Issue:** [#82 - Gasless/sponsored transactions on Stellar](https://github.com/Nullifier-Systems/velo/issues/82)
**Date:** July 2026

---

## Executive Summary

Stellar natively supports **fee-bump transactions** (CAP-0015), a protocol-level mechanism that allows one account to pay transaction fees on behalf of another without re-signing or modifying the original transaction. This is the ideal solution for enabling zero-XLM users to submit `lock()` calls in velo's escrow system.

**Key Finding:** Fee-bump transactions are fully feasible for velo's use case. The platform can sponsor fees for users who hold no XLM, allowing them to lock stablecoins in escrow. At typical volume (1,000 daily transactions), monthly sponsorship costs would be approximately **$0.60–$6.00 USD**.

---

## Technical Explanation

### How Fee-Bump Transactions Work

A fee-bump transaction wraps an existing signed transaction in an outer envelope:

```
┌─────────────────────────────────────────────┐
│  Outer Envelope (Fee-Bump Transaction)      │
│  ┌───────────────────────────────────────┐  │
│  │ Fee Account: G_SPONSOR...             │  │
│  │ Fee: 200,000 stroops                  │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │ Inner Transaction               │  │  │
│  │  │ Source: G_BUYER...               │  │  │
│  │  │ Operations: invokeHostFunction   │  │  │
│  │  │ Signature: Buyer's signature     │  │  │
│  │  └─────────────────────────────────┘  │  │
│  └───────────────────────────────────────┘  │
│  Signature: Sponsor's signature             │
└─────────────────────────────────────────────┘
```

**Key properties:**
1. The inner transaction is signed by the user (buyer) — their intent is preserved
2. The outer envelope is signed by the sponsor (fee payer)
3. The sponsor's account pays the fee, not the user's account
4. The user's sequence number is consumed (prevents replay)
5. No modification to the original transaction is needed

### Requirements

| Requirement | Details |
|-------------|---------|
| Inner transaction | Must be a valid, signed transaction |
| Fee account | Must exist and have sufficient XLM balance |
| Fee-bump fee | Must cover inner ops + 1 (the fee-bump itself) |
| Transaction size | Max 300KB for inner transaction XDR |
| Expiration | Inner transaction must be submitted before expiry |

### SDK Support

All major Stellar SDKs support fee-bump transactions:

```javascript
// JavaScript SDK (@stellar/stellar-sdk)
import * as StellarSdk from "@stellar/stellar-sdk";

// Build inner transaction
const innerTx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: StellarSdk.Networks.PUBLIC,
})
    .addOperation(StellarSdk.Operation.invokeHostFunction({
        hostFunction: { /* ... */ },
        auth: [/* ... */],
    }))
    .build();

// Sign with user's key
innerTx.sign(userKeypair);

// Create fee-bump transaction
const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    feeAccountKeypair,      // sponsor pays fee
    innerTx,                // user's signed transaction
    StellarSdk.Networks.PUBLIC
);

// Sign fee-bump with sponsor's key
feeBumpTx.sign(feeAccountKeypair);

// Submit
await server.submitTransaction(feeBumpTx);
```

---

## Feasibility Analysis for Velo

### Can Zero-XLM Users Submit lock() Calls?

**Yes.** Here's how it works in velo's context:

1. **User creates transaction:** The buyer builds a transaction invoking `lock()` on the escrow contract with their funds (USDC), secret hash, seller address, and timeout.

2. **User signs transaction:** The buyer signs the transaction with their wallet key. This proves they authorize the lock operation.

3. **Platform wraps in fee-bump:** The platform's fee sponsor account wraps the signed transaction in a fee-bump envelope and signs it.

4. **Submission:** The fee-bump transaction is submitted to the network. The sponsor's XLM balance pays the fee; the buyer's USDC is locked in the contract.

### Integration Points

```typescript
// API endpoint for gasless lock()
app.post('/api/v1/trades/gasless-lock', async (req, res) => {
    const { 
        innerTransactionXdr,  // Buyer's signed tx
        networkPassphrase 
    } = req.body;

    // Reconstruct the inner transaction
    const innerTx = new Transaction(
        innerTransactionXdr,
        networkPassphrase
    );

    // Wrap in fee-bump with sponsor
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
        feeAccount,           // Platform's funded account
        innerTx,
        networkPassphrase
    );
    feeBumpTx.sign(feeAccountKeypair);

    // Submit
    const result = await server.submitTransaction(feeBumpTx);
    res.json({ success: true, hash: result.hash });
});
```

### Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| Sponsor must have XLM balance | Platform needs funded accounts | Maintain hot wallet with XLM |
| Fee-bump adds ~1KB to tx size | Slight fee increase | Negligible for Soroban ops |
| Sequence number management | Inner tx consumes buyer's seqno | One-time: buyer needs existing account |
| Account creation | New users need initial account | Consider sponsored reserves |

### Security Considerations

1. **No key exposure:** The sponsor never sees the buyer's private key
2. **Intent preservation:** The inner transaction is immutable after signing
3. **Rate limiting:** Platform should rate-limit gasless submissions per user
4. **Audit trail:** Log all fee-bump submissions for reconciliation
5. **Account funding:** New users still need a Stellar account (can use sponsored reserves for account creation)

---

## Cost Estimates

### Stellar Fee Structure

| Fee Type | Amount | Description |
|----------|--------|-------------|
| Base fee | 100 stroops (0.00001 XLM) | Minimum per operation |
| Soroban resource fee | ~0.02–0.03 XLM avg | CPU, memory, storage |
| Fee-bump overhead | +1 operation | The outer envelope |

**Note:** Soroban transactions have two fee components:
- **Inclusion fee:** Max bid for ledger inclusion (100 stroops base)
- **Resource fee:** Based on actual resource consumption

### Cost Per Transaction

| Transaction Type | Estimated Fee (XLM) | Estimated Fee (USD)* |
|------------------|---------------------|----------------------|
| Simple payment | 0.00001 XLM | < $0.00001 |
| lock() call (typical) | 0.02–0.03 XLM | $0.000002–$0.000003 |
| lock() call (complex) | 0.05–0.10 XLM | $0.000005–$0.000010 |

*XLM price assumed at $0.10 USD (July 2026)

### Volume Projections

| Daily Transactions | Monthly Cost (XLM) | Monthly Cost (USD) |
|--------------------|--------------------|--------------------|
| 100 | 60–90 XLM | $6–$9 |
| 1,000 | 600–900 XLM | $60–$90 |
| 10,000 | 6,000–9,000 XLM | $600–$900 |

### Realistic Cost Estimate

For a platform processing **1,000 lock() transactions daily**:

- **Monthly cost:** ~600–900 XLM (~$60–$90 USD)
- **Annual cost:** ~7,200–10,800 XLM (~$720–$1,080 USD)

This is extremely affordable compared to:
- Ethereum gas sponsorship: $1,000+/month at similar volume
- Infrastructure costs (servers, APIs): $500+/month

---

## Recommendations

### Implementation Strategy

1. **Start with fee-bump transactions** — simplest path, native protocol support
2. **Maintain a fee sponsor hot wallet** — fund with 1,000–10,000 XLM buffer
3. **Add rate limiting** — prevent abuse (e.g., 10 gasless txns/day/user)
4. **Monitor XLM balance** — auto-replenish when below threshold
5. **Consider sponsored reserves** — for new user account creation

### Future Considerations

- **Sponsor pool:** Multiple sponsor accounts for redundancy
- **Batch fee-bumping:** Queue transactions and submit in batches
- **Fee estimation API:** Show users estimated cost before signing
- **Soroban auth entries:** For more complex sponsorship patterns

### OpenZeppelin Relayer

OpenZeppelin offers a Stellar relayer that extends fee sponsorship to Soroban contract invocations. This could be useful if the team wants to avoid managing fee sponsor accounts directly.

---

## References

- [CAP-0015: Fee-Bump Transactions](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0015.md)
- [Stellar Fee-Bump Transactions Guide](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions)
- [Soroban Fee Structure](https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering)
- [Signing Soroban Contract Invocations](https://developers.stellar.org/docs/build/guides/transactions/signing-soroban-invocations)
- [OpenZeppelin Stellar Relayer](https://docs.openzeppelin.com/relayer/1.3.x/guides/stellar-sponsored-transactions-guide)
