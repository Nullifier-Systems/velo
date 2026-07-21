# Stellar SEP Standards Analysis: Relevance to Velo Product Vision

## Executive Summary

This document analyzes how Stellar's existing anchor standards (SEP-24 and SEP-31) could replace custom-built infrastructure for Velo's product vision, specifically for CETES bonds, Blend DeFi, and bank on-ramp functionality.

**Key Finding:** The current Velo codebase does not contain implementations of CETES bonds, Blend DeFi, or bank on-ramp screens. These appear to be part of a future product vision that is currently UI-only/simulated. This analysis provides a roadmap for leveraging Stellar's standardized protocols when implementing these features.

## Current Velo Implementation Status

Based on codebase exploration, Velo currently implements:

- **Escrow-based conditional payment settlement** via Soroban smart contracts
- **HTLC primitives** for atomic swaps and cross-chain relayers
- **Payment-aware API layer** with rate limiting and x402-style challenge flows
- **Mobile-first claim experience** with QR-based handoff
- **Privacy-preserving architecture** (conceptual, anticipating ZK integration)

**Not Found in Current Codebase:**

- CETES bonds implementation
- Blend DeFi integration
- Bank on-ramp screens or infrastructure

## Stellar SEP Standards Overview

### SEP-24: Hosted Deposit and Withdrawal

**Purpose:** Standard protocol for wallets and anchors to interact for on/off-ramping

**Key Capabilities:**

- Deposit external assets with an anchor (fiat → crypto)
- Withdraw assets from an anchor (crypto → fiat)
- Communicate deposit & withdrawal fee structures
- Handle anchor KYC requirements via interactive webapp
- Check status of ongoing deposits/withdrawals
- View transaction history

**API Endpoints:**

- `POST /transactions/deposit/interactive` - Initiate deposit
- `POST /transactions/deposit/withdraw/interactive` - Initiate withdrawal
- `GET /info` - Anchor capabilities and supported assets
- `GET /transactions` - Transaction history
- `GET /transaction` - Single transaction status

**Authentication:** Requires SEP-10 or SEP-45 web authentication

**Asset Conversion:** Supports SEP-38 for non-equivalent token bridging (e.g., ARS bank transfer → USDC on Stellar)

### SEP-31: Cross-Border Payments API

**Purpose:** Protocol for payments between two financial accounts outside Stellar network

**Key Capabilities:**

- Cross-border payments via sending/receiving anchor model
- KYC handling via SEP-12 integration
- Rate quotes via SEP-38 RFQ API
- Multi-jurisdictional compliance support
- Callback-based status updates

**Entities:**

- Sending Client (origin account owner)
- Sending Anchor (receives funds, sends to receiving anchor)
- Receiving Anchor (receives Stellar payment, delivers to destination)
- Receiving Client (destination account owner)

**Flow:**

1. Sending Client → Sending Anchor (off-chain)
2. Sending Anchor → Receiving Anchor (on-Stellar)
3. Receiving Anchor → Receiving Client (off-chain)

**API Endpoints:**

- `GET /info` - Receiving anchor capabilities
- `POST /transactions` - Create cross-border transaction
- `GET /transactions/:id` - Transaction status
- `PUT /transactions/:id/callback` - Register status callback

## Mapping SEPs to Product Vision Features

### Bank On-Ramp Screens

**Current Status:** UI-only/simulated (not found in codebase)

**SEP-24 Applicability:** **HIGH**

**How SEP-24 Replaces Custom Infrastructure:**

| Custom Component         | SEP-24 Replacement                        | Benefit                               |
| ------------------------ | ----------------------------------------- | ------------------------------------- |
| Bank account input forms | Anchor-hosted interactive webapp          | Offloads KYC/AML compliance to anchor |
| Deposit status tracking  | `GET /transactions` endpoint              | Standardized status model             |
| Fee calculation logic    | `GET /info` + SEP-38 `/price`             | Transparent, market-driven pricing    |
| Transaction history      | `GET /transactions` with pagination       | Built-in audit trail                  |
| Withdrawal processing    | `POST /transactions/withdraw/interactive` | Standardized withdrawal flow          |

**Implementation Recommendation:**

- Implement SEP-24 client instead of custom bank integration
- Leverage existing Stellar anchors for on-ramp/off-ramp
- Use SEP-38 for asset conversion (e.g., MXN → USDC)
- Maintain Velo's escrow layer for conditional settlement post-on-ramp

**Simplified Architecture:**

```
User → Velo Wallet (SEP-24 Client) → Anchor (SEP-24 Server) → Bank
                                    ↓
                              Velo Escrow Contract
```

### CETES Bonds

**Current Status:** Not found in codebase (future product vision)

**SEP-24/31 Applicability:** **MEDIUM** (indirect)

**Analysis:**
CETES bonds are Mexican government treasury instruments. While SEP standards don't directly implement bond trading, they can support the infrastructure around it:

| Bond Trading Component  | SEP Support            | Notes                           |
| ----------------------- | ---------------------- | ------------------------------- |
| Fiat on-ramp (MXN)      | SEP-24                 | Convert MXN to stablecoins      |
| Cross-border settlement | SEP-31                 | If bonds traded internationally |
| KYC/AML compliance      | SEP-12 (via SEP-24/31) | Regulatory requirements         |
| Asset custody           | Not covered            | Requires custom implementation  |
| Bond smart contracts    | Not covered            | Requires Soroban implementation |

**Implementation Recommendation:**

- Use SEP-24 for MXN → USDC on-ramp
- Build custom Soroban contracts for CETES bond logic
- Use SEP-31 if cross-border bond trading is required
- Leverage SEP-12 for KYC if regulatory compliance needed

**Simplified Architecture:**

```
User → Velo Wallet → SEP-24 Anchor → MXN Bank
                    ↓
              USDC on Stellar
                    ↓
        Custom CETES Bond Contract (Soroban)
```

### Blend DeFi

**Current Status:** Not found in codebase (future product vision)

**SEP-24/31 Applicability:** **LOW** (indirect)

**Analysis:**
Blend is a lending protocol on Stellar. SEP standards primarily address fiat on/off-ramping and cross-border payments, not DeFi lending protocols:

| DeFi Component              | SEP Support | Notes                               |
| --------------------------- | ----------- | ----------------------------------- |
| Fiat on-ramp for collateral | SEP-24      | Convert fiat to collateral assets   |
| Cross-border collateral     | SEP-31      | International collateral deposits   |
| Lending/borrowing logic     | Not covered | Requires Blend protocol integration |
| Liquidity pools             | Not covered | Requires DeFi protocol integration  |
| Interest rate mechanisms    | Not covered | Requires DeFi protocol integration  |

**Implementation Recommendation:**

- Use SEP-24 for fiat on-ramp to provide collateral
- Integrate directly with Blend protocol for lending/borrowing
- Use SEP-31 if cross-border collateral deposits are needed
- SEP standards do not replace DeFi protocol integration

**Simplified Architecture:**

```
User → Velo Wallet → SEP-24 Anchor → Bank
                    ↓
              Collateral Asset
                    ↓
            Blend Protocol (DeFi)
```

## Simplification Opportunities Summary

### High-Impact Simplifications

1. **Bank On-Ramp Infrastructure**
   - **Replace:** Custom bank integration, KYC forms, status tracking
   - **With:** SEP-24 client implementation
   - **Effort Reduction:** ~60-80% reduction in custom code
   - **Risk Reduction:** Offloads regulatory compliance to licensed anchors

2. **KYC/AML Compliance**
   - **Replace:** Custom identity verification flows
   - **With:** SEP-12 integration (via SEP-24/31)
   - **Effort Reduction:** ~70% reduction in compliance code
   - **Standardization:** Industry-standard KYC fields and flows

### Medium-Impact Simplifications

3. **Cross-Border Payment Infrastructure**
   - **Replace:** Custom international transfer logic
   - **With:** SEP-31 for cross-border flows
   - **Effort Reduction:** ~50% reduction in cross-border code
   - **Use Case:** International CETES trading or multi-jurisdictional operations

4. **Fee Calculation and Display**
   - **Replace:** Custom fee logic
   - **With:** SEP-38 RFQ API for transparent pricing
   - **Effort Reduction:** ~40% reduction in pricing code
   - **Benefit:** Market-driven, competitive pricing

### Low-Impact/No Replacement

5. **CETES Bond Logic**
   - **No SEP Replacement:** Requires custom Soroban implementation
   - **SEP Support:** Only for on-ramp/off-ramp infrastructure
   - **Recommendation:** Build custom contracts, use SEPs for peripheral flows

6. **Blend DeFi Integration**
   - **No SEP Replacement:** Requires direct protocol integration
   - **SEP Support:** Only for collateral on-ramp
   - **Recommendation:** Integrate Blend directly, use SEPs for fiat entry

## Recommended Implementation Roadmap

### Phase 1: Bank On-Ramp (Highest Priority)

1. Implement SEP-24 client in Velo wallet
2. Integrate with existing Stellar anchors (e.g., Circle, BTC Markets)
3. Replace simulated bank on-ramp screens with SEP-24 interactive flows
4. Add SEP-38 integration for transparent fee display and asset conversion

### Phase 2: CETES Bonds Infrastructure

1. Design Soroban contracts for CETES bond logic
2. Use SEP-24 for MXN → USDC on-ramp
3. Implement SEP-12 KYC if Mexican regulations require
4. Consider SEP-31 if international bond trading is planned

### Phase 3: Blend DeFi Integration

1. Integrate directly with Blend protocol for lending/borrowing
2. Use SEP-24 for fiat collateral on-ramp
3. Consider SEP-31 for cross-border collateral deposits
4. Build custom UI for DeFi operations (no SEP replacement)

## Technical Considerations

### Dependencies

- **SEP-10/45:** Required authentication for SEP-24/31
- **SEP-12:** KYC server (required by many anchors)
- **SEP-38:** Quote API for fee transparency and asset conversion
- **stellar.toml:** Must be configured for SEP discovery

### Anchor Selection

- Choose anchors with strong regulatory compliance
- Verify support for required asset pairs (MXN, USDC, etc.)
- Confirm SEP-24 and SEP-31 support levels
- Evaluate fee structures via SEP-38

### Integration Points

- Velo's existing escrow contracts can layer on top of SEP-24 on-ramp
- Payment challenge flow (x402) can be preserved for API access
- Mobile QR experience can incorporate SEP-24 interactive flows
- Privacy architecture can be maintained (SEPs don't expose user data beyond KYC)

## Conclusion

Stellar's SEP standards offer significant simplification opportunities for Velo's product vision:

- **Bank On-Ramp:** SEP-24 can replace ~60-80% of custom infrastructure
- **CETES Bonds:** SEPs support peripheral flows (on-ramp, KYC) but not bond logic
- **Blend DeFi:** SEPs support collateral on-ramp but not DeFi protocol integration

**Recommendation:** Prioritize SEP-24 implementation for bank on-ramp functionality as it offers the highest simplification potential. Use SEPs as infrastructure building blocks while building custom logic for domain-specific features (bond contracts, DeFi integration).

## References

- [SEP-24: Hosted Deposit and Withdrawal](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md)
- [SEP-31: Cross-Border Payments API](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md)
- [SEP-12: KYC API](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md)
- [SEP-38: Anchor RFQ API](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md)
- [Stellar Anchor Platform](https://developers.stellar.org/docs/platforms/anchor-platform/)
