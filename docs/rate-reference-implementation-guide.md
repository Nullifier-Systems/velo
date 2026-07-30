# Rate Reference System Implementation Guide

## Overview

This guide provides practical information for implementing and using the rate reference system in the Velo platform.

## Architecture

The system combines two independent price sources:
1. **Stellar DEX**: On-chain liquidity pool data for USDC/XLM
2. **CoinGecko API**: External fiat rate data for USDC/USD and XLM/USD

Rates are reconciled using a weighted median approach with confidence scoring.

## Configuration

### Environment Variables

Add the following to your `.env` file:

```bash
# Stellar RPC endpoint
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

# Stellar DEX USDC/XLM pool ID (testnet)
USDC_XLM_POOL_ID=<POOL_ID>

# For mainnet, use mainnet RPC and pool ID
# SOROBAN_RPC_URL=https://horizon.stellar.org
# USDC_XLM_POOL_ID=<MAINNET_POOL_ID>
```

### Finding Pool IDs

**Testnet**:
- Use Stellar Expert to find USDC/XLM liquidity pools on testnet
- Look for pools with sufficient liquidity

**Mainnet**:
- Use Stellar Expert to find the main USDC/XLM pool
- Prefer pools with high liquidity and volume

## API Endpoints

### GET /api/v1/rates/reference

Returns current reference rates with confidence scores.

**Response Example**:
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
    "sources": [...],
    "reconciled_rate": 1.0,
    "confidence_score": 0.95,
    "deviation_warning": false
  },
  "xlm_usd": {
    "rate": 0.2857,
    "sources": [...],
    "reconciled_rate": 0.2857,
    "confidence_score": 0.95,
    "deviation_warning": false
  }
}
```

### GET /api/v1/rates/reference?pair=usdc_xlm

Returns data for a specific pair only.

### GET /api/v1/rates/history?pair=usdc_xlm&period=24h

Returns historical rate data (currently mock data - requires database for full implementation).

### GET /api/v1/rates/health

Health check for rate sources.

**Response Example**:
```json
{
  "timestamp": "2026-07-27T18:00:00Z",
  "sources": {
    "stellar_dex": {
      "available": true,
      "confidence": 0.85
    },
    "coingecko": {
      "available": true,
      "confidence": 0.90
    }
  },
  "overall_confidence": {
    "usdc_xlm": 0.88,
    "usdc_usd": 0.95,
    "xlm_usd": 0.95
  },
  "deviation_warnings": {
    "usdc_xlm": false,
    "usdc_usd": false,
    "xlm_usd": false
  }
}
```

## Integration with Provider System

### Display Reference Rates

When displaying provider rates to users, include the reference rate for comparison:

```typescript
const referenceRate = await getRateReference();
const providerRate = provider.rate;

const deviation = ((providerRate - referenceRate.usdc_xlm.reconciled_rate) / referenceRate.usdc_xlm.reconciled_rate) * 100;

// Display to user
console.log(`Provider rate: ${providerRate} XLM/USDC`);
console.log(`Reference rate: ${referenceRate.usdc_xlm.reconciled_rate} XLM/USDC (${referenceRate.usdc_xlm.confidence_score * 100}% confidence)`);
console.log(`Deviation: ${deviation.toFixed(2)}%`);
```

### Advisory Messaging

Always include advisory messaging:

```typescript
if (Math.abs(deviation) > 10) {
  console.warn("⚠️ Provider rate deviates significantly from reference rate");
  console.warn("Please verify the rate before proceeding");
}
```

## Testing

### Unit Tests

Run the reconciliation algorithm tests:

```bash
cd apps/api
npm test -- lib/rates.test.ts
```

### Manual Testing

Test the API endpoints:

```bash
# Get all rates
curl http://localhost:3000/api/v1/rates/reference

# Get specific pair
curl http://localhost:3000/api/v1/rates/reference?pair=usdc_xlm

# Check health
curl http://localhost:3000/api/v1/rates/health
```

## Error Handling

### Source Failures

The system is designed to handle source failures gracefully:

- If Stellar DEX fails: Falls back to CoinGecko only
- If CoinGecko fails: Uses cached data with reduced confidence
- If both fail: Returns error with 502 status

### Low Confidence

When confidence scores are low (<0.5), the system:
- Still returns rates but with warning flags
- Reduces overall confidence score
- Flags deviation warnings more aggressively

## Rate Limiting

The rate endpoints are rate-limited:
- `/rates/reference`: 60 req/min
- `/rates/history`: 30 req/min
- `/rates/health`: 60 req/min

## Future Enhancements

### Historical Data Storage

To implement true historical data:
1. Add database table for rate snapshots
2. Schedule periodic rate collection (e.g., every 5 minutes)
3. Query historical data for `/rates/history` endpoint

### Additional Sources

Add more price sources for redundancy:
- Binance API
- Kraken API
- Stellar DEX multiple pools
- Custom on-chain oracle

### On-Chain Oracle

Consider deploying a Soroban oracle contract for:
- On-chain rate aggregation
- Smart contract access to rates
- Reduced API dependency

## Monitoring

### Key Metrics to Monitor

- Source availability (uptime)
- Confidence scores trends
- Deviation warning frequency
- API response times
- Cache hit rates

### Alerting

Set up alerts for:
- Source failures (both sources down)
- Confidence scores dropping below threshold
- Frequent deviation warnings
- API rate limit breaches

## Security Considerations

### API Key Protection

If using paid APIs (not currently used):
- Store API keys in environment variables
- Never commit keys to repository
- Rotate keys regularly

### Rate Limit Abuse

Monitor for:
- Excessive requests from single IPs
- Patterns suggesting scraping
- Unusual traffic spikes

### Data Validation

Always validate:
- Rate values are reasonable (not negative, not extreme)
- Confidence scores are within valid range
- Timestamps are recent

## Troubleshooting

### Issue: Stellar DEX Returns Error

**Possible Causes**:
- Pool ID is incorrect
- Pool has no liquidity
- RPC endpoint is down

**Solutions**:
- Verify pool ID using Stellar Expert
- Check pool liquidity
- Verify RPC endpoint is accessible

### Issue: CoinGecko API Fails

**Possible Causes**:
- API rate limit exceeded
- Network connectivity issues
- API service down

**Solutions**:
- Check API status page
- Implement retry logic with exponential backoff
- Use cached data with warning

### Issue: High Deviation Warning

**Possible Causes**:
- Genuine price volatility
- One source providing stale data
- Manipulation attempt

**Solutions**:
- Check individual source timestamps
- Verify source data freshness
- Monitor for patterns suggesting manipulation

## Conclusion

The rate reference system provides a robust, multi-source approach to rate information that enhances user experience while maintaining the peer-to-peer negotiation model. Proper configuration and monitoring ensure reliable operation.
