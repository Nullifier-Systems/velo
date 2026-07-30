# Rate Reference System Design

## Overview

This document describes the design and implementation of a decentralized rate reference system for the Velo platform. The system combines multiple independent price sources to provide advisory rate information to both buyers and sellers without enforcing rates, preserving the peer-to-peer negotiation model.

## Problem Statement

Providers currently set their own conversion rates with no reference point. This creates two problems:
1. Bad-faith providers can quote exploitative rates to unsophisticated users
2. Good-faith providers lack guidance on what constitutes a "fair" rate

## Design Principles

1. **Multi-Source**: Combine at least two independent price sources
2. **Advisory Only**: Rates are shown as reference, not enforced
3. **Decentralized**: Avoid dependence on a single centralized price feed
4. **Transparent**: Clear methodology for rate calculation and disagreement reconciliation
5. **Manipulation-Resistant**: Defend against price manipulation attacks

## Architecture

### Price Sources

#### Source 1: Stellar DEX On-Chain Pricing
- **Method**: Query Stellar DEX liquidity pools for USDC/XLM market
- **Contract**: Standard Stellar AMM pool
- **Advantages**: On-chain, transparent, difficult to manipulate without significant capital
- **Limitations**: Only provides crypto-to-crypto rates, not fiat rates

#### Source 2: External Fiat API (CoinGecko)
- **Method**: REST API call to CoinGecko for USDC/USD and XLM/USD rates
- **Advantages**: Provides fiat reference rates, widely used, reliable
- **Limitations**: Centralized, potential API downtime, rate limits

### Reconciliation Method

When sources disagree, the system uses a **weighted median** approach:

1. Fetch rates from all sources
2. Calculate deviation from median
3. Apply confidence scores based on:
   - Source reliability (historical uptime)
   - Recency of data
   - Volume/liquidity (for DEX)
4. Compute weighted average
5. Flag significant deviations (>5%) for user attention

### Data Flow

```
┌─────────────────┐
│  API Endpoint   │
│  /rates/reference│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Rate Aggregator │
│  (fetches from   │
│   multiple       │
│   sources)       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Reconciliation  │
│  Engine          │
│  (weighted       │
│   median,        │
│   confidence)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Response       │
│  (rates +       │
│   confidence    │
│   score +       │
│   warnings)     │
└─────────────────┘
```

## Implementation Details

### API Endpoints

#### GET /api/v1/rates/reference
Returns current reference rates with confidence scores.

**Response**:
```json
{
  "timestamp": "2026-07-27T18:00:00Z",
  "usdc_xlm": {
    "rate": 3.5,
    "sources": [
      {
        "name": "stellar_dex",
        "rate": 3.52,
        "confidence": 0.85
      },
      {
        "name": "coingecko",
        "rate": 3.48,
        "confidence": 0.90
      }
    ],
    "reconciled_rate": 3.5,
    "confidence_score": 0.88,
    "deviation_warning": false
  },
  "usdc_usd": {
    "rate": 1.0,
    "sources": [
      {
        "name": "coingecko",
        "rate": 1.0,
        "confidence": 0.95
      }
    ],
    "reconciled_rate": 1.0,
    "confidence_score": 0.95,
    "deviation_warning": false
  },
  "xlm_usd": {
    "rate": 0.2857,
    "sources": [
      {
        "name": "coingecko",
        "rate": 0.2857,
        "confidence": 0.95
      }
    ],
    "reconciled_rate": 0.2857,
    "confidence_score": 0.95,
    "deviation_warning": false
  }
}
```

#### GET /api/v1/rates/history?pair=usdc_xlm&period=24h
Returns historical rate data for trend analysis.

### Rate Calculation

**Stellar DEX Rate Calculation**:
```typescript
async function getStellarDexRate(): Promise<number> {
  // Query AMM pool for USDC/XLM
  const poolId = STELLAR_USDC_XLM_POOL_ID;
  const pool = await server.getLiquidityPool(poolId);
  
  // Calculate spot price from reserves
  const { reserve_a, reserve_b } = pool.reserves;
  const rate = reserve_b / reserve_a; // XLM per USDC
  
  return rate;
}
```

**CoinGecko Rate Calculation**:
```typescript
async function getCoinGeckoRate(base: string, quote: string): Promise<number> {
  const response = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${base}&vs_currencies=${quote}`
  );
  const data = await response.json();
  return data[base][quote];
}
```

**Reconciliation Algorithm**:
```typescript
function reconcileRates(sources: RateSource[]): ReconciledRate {
  // Calculate median
  const rates = sources.map(s => s.rate);
  const median = calculateMedian(rates);
  
  // Calculate weighted average based on confidence
  const totalConfidence = sources.reduce((sum, s) => sum + s.confidence, 0);
  const weightedRate = sources.reduce(
    (sum, s) => sum + (s.rate * s.confidence),
    0
  ) / totalConfidence;
  
  // Check for significant deviation
  const maxDeviation = Math.max(...rates.map(r => Math.abs(r - median) / median));
  const deviationWarning = maxDeviation > 0.05; // 5% threshold
  
  return {
    reconciled_rate: weightedRate,
    confidence_score: totalConfidence / sources.length,
    deviation_warning: deviationWarning
  };
}
```

## Security Considerations

### Manipulation Attacks

#### DEX Manipulation
- **Attack**: Large actor manipulates pool reserves to affect price
- **Defense**: 
  - Use high-liquidity pools (harder to manipulate)
  - Implement minimum liquidity threshold
  - Cross-reference with external sources
  - Time-weighted average prices (TWAP) for stability

#### API Manipulation
- **Attack**: External API provides incorrect data
- **Defense**:
  - Multiple independent external sources
  - Rate limiting and caching
  - Fallback to on-chain data if API fails
  - Historical anomaly detection

### Data Freshness

- **Stellar DEX**: Real-time (current ledger)
- **CoinGecko API**: Cached with 5-minute TTL
- **Fallback**: If source unavailable, use last known good rate with warning

## Integration with Existing System

### Provider Registration Update

Providers can optionally display their rate relative to reference:

```typescript
interface Provider {
  // ... existing fields
  rate?: string;
  reference_rate?: string;
  rate_deviation?: number; // percentage difference from reference
}
```

### UI Display

The reference rate is shown to both parties:
- **Buyer**: "Reference rate: 1 USDC = 3.5 XLM (88% confidence)"
- **Seller**: "Reference rate: 1 USDC = 3.5 XLM (88% confidence)"
- Both parties see provider's rate deviation from reference

### Advisory Nature

The system explicitly states:
- "This is a reference rate for informational purposes only"
- "Actual rates are negotiated between buyer and seller"
- "Significant deviations from reference may warrant additional verification"

## Testing Strategy

### Unit Tests
- Rate fetching from each source
- Reconciliation algorithm
- Confidence score calculation
- Deviation detection

### Integration Tests
- End-to-end rate fetching
- API endpoint responses
- Error handling (source failures)
- Caching behavior

### Mock Tests
- Simulated DEX pool data
- Mocked API responses
- Failure scenarios

## Future Enhancements

1. **Additional Sources**: Add more price sources (Binance, Kraken, etc.)
2. **On-Chain Oracle**: Consider deploying a Soroban oracle contract
3. **Historical Analysis**: Trend detection and anomaly alerts
4. **Reputation System**: Track provider rate history vs reference
5. **User Feedback**: Allow users to flag suspicious rates

## Conclusion

This rate reference system provides a decentralized, multi-source approach to rate information that:
- Combines on-chain and off-chain data sources
- Uses transparent reconciliation methodology
- Maintains advisory nature (non-enforcing)
- Preserves peer-to-peer negotiation model
- Defends against manipulation through diversification

The system gives both buyers and sellers a common reference point while maintaining the flexibility of direct negotiation.
