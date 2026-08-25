import { Server, Api } from "@stellar/stellar-sdk/rpc";
import { Horizon } from "@stellar/stellar-sdk";

const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const RPC_ALLOW_HTTP = RPC_URL.startsWith("http://");
export const server = new Server(RPC_URL, { allowHttp: RPC_ALLOW_HTTP });

// Horizon API for Stellar DEX operations
const HORIZON_URL = process.env.STELLAR_NETWORK === "PUBLIC" 
  ? "https://horizon.stellar.org"
  : "https://horizon-testnet.stellar.org";
const horizonServer = new Horizon.Server(HORIZON_URL);

// Stellar DEX USDC/XLM pool ID (testnet - replace with mainnet pool ID in production)
const USDC_XLM_POOL_ID = process.env.USDC_XLM_POOL_ID || "";

// CoinGecko API configuration
const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";
const COINGECKO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export interface RateSource {
  name: string;
  rate: number;
  confidence: number;
  timestamp: Date;
}

export interface ReconciledRate {
  reconciled_rate: number;
  confidence_score: number;
  deviation_warning: boolean;
  sources: RateSource[];
}

export interface RateReference {
  timestamp: string;
  usdc_xlm: ReconciledRate;
  usdc_usd: ReconciledRate;
  xlm_usd: ReconciledRate;
  /**
   * Issue #420: time-weighted average of recent USDC/XLM samples.
   * Collateral valuation against the TWAP prevents flash-swap rate skewing
   * that a single-ledger spot quote would allow. Null until samples exist.
   */
  usdc_xlm_twap?: TwapSnapshot | null;
}

// Simple in-memory cache for CoinGecko rates
const coinGeckoCache = new Map<string, { rate: number; timestamp: number }>();

/**
 * Fetch USDC/XLM rate from Stellar DEX liquidity pool
 */
export async function getStellarDexRate(): Promise<RateSource> {
  if (!USDC_XLM_POOL_ID) {
    throw new Error("USDC_XLM_POOL_ID not configured");
  }

  try {
    // Use Horizon API to fetch liquidity pool data
    const pool = await horizonServer.liquidityPools().liquidityPoolId(USDC_XLM_POOL_ID).call();
    
    // Calculate spot price from reserves
    const reserves = pool.reserves;
    if (!reserves || reserves.length < 2) {
      throw new Error("Invalid pool reserves");
    }

    const reserveA = BigInt(reserves[0].amount);
    const reserveB = BigInt(reserves[1].amount);
    
    // Rate = XLM per USDC
    const rate = Number(reserveB) / Number(reserveA);
    
    // Confidence based on pool liquidity (higher liquidity = higher confidence)
    const totalLiquidity = Number(reserveA) + Number(reserveB);
    const liquidityConfidence = Math.min(0.95, Math.max(0.5, Math.log10(totalLiquidity) / 10));
    
    return {
      name: "stellar_dex",
      rate,
      confidence: liquidityConfidence,
      timestamp: new Date(),
    };
  } catch (error) {
    throw new Error(`Failed to fetch Stellar DEX rate: ${error}`);
  }
}

/**
 * Fetch rate from CoinGecko API with caching
 */
export async function getCoinGeckoRate(base: string, quote: string): Promise<RateSource> {
  const cacheKey = `${base}_${quote}`;
  const cached = coinGeckoCache.get(cacheKey);
  const now = Date.now();
  
  // Return cached value if still valid
  if (cached && now - cached.timestamp < COINGECKO_CACHE_TTL) {
    return {
      name: "coingecko",
      rate: cached.rate,
      confidence: 0.90, // High confidence for established API
      timestamp: new Date(cached.timestamp),
    };
  }

  try {
    // Map asset names to CoinGecko IDs
    const coinIds: Record<string, string> = {
      usdc: "usd-coin",
      xlm: "stellar",
      usd: "usd",
    };

    const baseId = coinIds[base.toLowerCase()];
    const quoteId = coinIds[quote.toLowerCase()];
    
    if (!baseId || !quoteId) {
      throw new Error(`Unsupported asset pair: ${base}/${quote}`);
    }

    const response = await fetch(
      `${COINGECKO_API_BASE}/simple/price?ids=${baseId}&vs_currencies=${quoteId}`
    );

    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }

    const data = await response.json();
    const rate = data[baseId][quoteId];

    if (typeof rate !== "number") {
      throw new Error(`Invalid rate from CoinGecko: ${rate}`);
    }

    // Cache the result
    coinGeckoCache.set(cacheKey, { rate, timestamp: now });

    return {
      name: "coingecko",
      rate,
      confidence: 0.90,
      timestamp: new Date(),
    };
  } catch (error) {
    // If we have cached data, return it with a warning
    if (cached) {
      return {
        name: "coingecko",
        rate: cached.rate,
        confidence: 0.50, // Lower confidence for stale data
        timestamp: new Date(cached.timestamp),
      };
    }
    throw new Error(`Failed to fetch CoinGecko rate: ${ error}`);
  }
}

/**
 * Calculate median of an array of numbers
 */
export function calculateMedian(numbers: number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Reconcile rates from multiple sources using weighted median
 */
export function reconcileRates(sources: RateSource[]): ReconciledRate {
  if (sources.length === 0) {
    throw new Error("No rate sources provided");
  }

  if (sources.length === 1) {
    return {
      reconciled_rate: sources[0].rate,
      confidence_score: sources[0].confidence,
      deviation_warning: false,
      sources,
    };
  }

  const rates = sources.map(s => s.rate);
  const median = calculateMedian(rates);
  
  // Calculate weighted average based on confidence
  const totalConfidence = sources.reduce((sum, s) => sum + s.confidence, 0);
  const weightedRate = sources.reduce(
    (sum, s) => sum + (s.rate * s.confidence),
    0
  ) / totalConfidence;
  
  // Check for significant deviation from median
  const maxDeviation = Math.max(...rates.map(r => Math.abs(r - median) / median));
  const deviationWarning = maxDeviation > 0.05; // 5% threshold
  
  // Overall confidence score is average of source confidences
  const confidenceScore = totalConfidence / sources.length;
  
  // Reduce confidence if there's significant deviation
  const adjustedConfidence = deviationWarning ? confidenceScore * 0.8 : confidenceScore;

  return {
    reconciled_rate: weightedRate,
    confidence_score: adjustedConfidence,
    deviation_warning: deviationWarning,
    sources,
  };
}

/**
 * ---------------------------------------------------------------------------
 * TWAP — time-weighted average price (issue #420).
 *
 * Spot rates can be skewed for one ledger close by a flash-loan-funded
 * swap, so collateral valuation must never trust a single observation.
 * Every DEX/Coingecko sample is retained and the release paths value
 * collateral against the time-weighted average over a trailing window,
 * which damps same-ledger spikes to near irrelevance.
 * ---------------------------------------------------------------------------
 */

/** Maximum samples retained per pair. */
export const TWAP_WINDOW_SAMPLES = 60;
/** Trailing window over which the average is weighted (~15 minutes). */
export const TWAP_WINDOW_MS = 15 * 60 * 1000;

export interface TwapSample {
  rate: number;
  /** Epoch milliseconds. */
  timestamp: number;
}

export interface TwapSnapshot {
  twap: number;
  sample_count: number;
  window_seconds: number;
}

const twapSamples = new Map<string, TwapSample[]>();

/** Records a rate observation for a pair's TWAP series. Invalid rates are ignored. */
export function recordRateSample(
  pair: string,
  rate: number,
  timestamp: number = Date.now(),
): void {
  if (!Number.isFinite(rate) || rate <= 0) return;
  const list = twapSamples.get(pair) ?? [];
  list.push({ rate, timestamp });
  while (
    list.length > TWAP_WINDOW_SAMPLES ||
    (list.length > 1 && timestamp - list[0].timestamp > TWAP_WINDOW_MS)
  ) {
    list.shift();
  }
  twapSamples.set(pair, list);
}

/**
 * Time-weighted average of `samples`: each observation is weighted by how
 * long it stood until the next one (the last until `now`). Returns null
 * with no data; falls back to the arithmetic mean when every sample shares
 * a single timestamp, so a burst of same-instant quotes still averages
 * instead of collapsing to the last quote.
 */
export function calculateTwap(
  samples: TwapSample[],
  now: number = Date.now(),
): TwapSnapshot | null {
  if (samples.length === 0) return null;

  const sorted = [...samples].sort((a, b) => a.timestamp - b.timestamp);
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < sorted.length; i++) {
    const end = i === sorted.length - 1 ? Math.max(now, sorted[i].timestamp) : sorted[i + 1].timestamp;
    const weight = Math.max(0, end - sorted[i].timestamp);
    weightedSum += sorted[i].rate * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    return {
      twap: sorted.reduce((sum, s) => sum + s.rate, 0) / sorted.length,
      sample_count: sorted.length,
      window_seconds: 0,
    };
  }

  return {
    twap: weightedSum / totalWeight,
    sample_count: sorted.length,
    window_seconds: Math.max(0, Math.round((now - sorted[0].timestamp) / 1000)),
  };
}

/** Current TWAP snapshot for a pair, or null if nothing has been sampled yet. */
export function getTwap(pair: string): TwapSnapshot | null {
  return calculateTwap(twapSamples.get(pair) ?? []);
}

/**
 * Fetch all reference rates
 */
export async function getRateReference(): Promise<RateReference> {
  const sources: RateSource[] = [];

  // Try to fetch from Stellar DEX
  try {
    const dexRate = await getStellarDexRate();
    sources.push(dexRate);
  } catch (error) {
    console.warn("Failed to fetch Stellar DEX rate:", error);
  }

  // Try to fetch from CoinGecko for USDC/XLM
  try {
    const coinGeckoRate = await getCoinGeckoRate("usdc", "xlm");
    sources.push(coinGeckoRate);
  } catch (error) {
    console.warn("Failed to fetch CoinGecko USDC/XLM rate:", error);
  }

  // Issue #420: feed every observation into the TWAP series so collateral
  // valuation can average away flash-swap spikes instead of trusting spot.
  for (const source of sources) {
    recordRateSample("usdc_xlm", source.rate, source.timestamp.getTime());
  }

  // Reconcile USDC/XLM rate
  const usdcXlm = sources.length > 0 
    ? reconcileRates(sources)
    : {
        reconciled_rate: 0,
        confidence_score: 0,
        deviation_warning: true,
        sources: [],
      };

  // Fetch USDC/USD (only from CoinGecko)
  let usdcUsd: ReconciledRate;
  try {
    const usdcUsdSource = await getCoinGeckoRate("usdc", "usd");
    usdcUsd = reconcileRates([usdcUsdSource]);
  } catch (error) {
    console.warn("Failed to fetch USDC/USD rate:", error);
    usdcUsd = {
      reconciled_rate: 1.0, // Fallback to 1:1
      confidence_score: 0,
      deviation_warning: true,
      sources: [],
    };
  }

  // Fetch XLM/USD (only from CoinGecko)
  let xlmUsd: ReconciledRate;
  try {
    const xlmUsdSource = await getCoinGeckoRate("xlm", "usd");
    xlmUsd = reconcileRates([xlmUsdSource]);
  } catch (error) {
    console.warn("Failed to fetch XLM/USD rate:", error);
    xlmUsd = {
      reconciled_rate: 0,
      confidence_score: 0,
      deviation_warning: true,
      sources: [],
    };
  }

  return {
    timestamp: new Date().toISOString(),
    usdc_xlm: usdcXlm,
    usdc_usd: usdcUsd,
    xlm_usd: xlmUsd,
    usdc_xlm_twap: getTwap("usdc_xlm"),
  };
}
