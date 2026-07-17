/**
 * Lightweight fraud detection for cash requests.
 *
 * Strategy: flag (never block) suspicious requests so that operators can
 * investigate without disrupting legitimate users.
 *
 * Signals checked
 * ───────────────
 * 1. Velocity — same buyer address submits more than
 *    FRAUD_MAX_REQUESTS_PER_WINDOW requests inside a rolling
 *    FRAUD_WINDOW_MS millisecond window.
 * 2. Large amount — single request exceeds FRAUD_LARGE_AMOUNT_STROOPS.
 *
 * Configuration (environment variables)
 * ─────────────────────────────────────
 * FRAUD_MAX_REQUESTS_PER_WINDOW   Max requests allowed per buyer per window
 *                                 before flagging (default: 5)
 * FRAUD_WINDOW_MS                 Sliding-window duration in ms (default: 60000 = 1 min)
 * FRAUD_LARGE_AMOUNT_STROOPS      Stroops threshold for a single large-amount
 *                                 flag (default: 100_000_000_000 = 1 000 000 XLM equiv.)
 *                                 Set to 0 to disable large-amount detection.
 *
 * False-positive considerations
 * ─────────────────────────────
 * • Shared infrastructure (NAT gateways, corporate offices) will have a
 *   single buyer address for many real users — tune FRAUD_MAX_REQUESTS_PER_WINDOW
 *   upward or disable velocity checks for known-good addresses.
 * • Programmatic integrations (wallets, batch scripts) may legitimately
 *   submit many requests in a short window — whitelist via FRAUD_BUYER_ALLOWLIST.
 * • The store is in-process only; horizontal scaling requires an external
 *   cache (Redis) for shared state.
 */

import "dotenv/config";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface FraudConfig {
  /** Maximum number of requests a buyer may create inside the window. */
  maxRequestsPerWindow: number;
  /** Sliding-window width in milliseconds. */
  windowMs: number;
  /** Single-request amount (in stroops) that triggers a large-amount flag.
   *  Set to 0 to disable. */
  largeAmountStroops: bigint;
  /** Comma-separated buyer addresses that are permanently whitelisted. */
  buyerAllowlist: Set<string>;
}

function loadConfig(): FraudConfig {
  const allowlistRaw = process.env.FRAUD_BUYER_ALLOWLIST ?? "";
  const allowlist = new Set(
    allowlistRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  return {
    maxRequestsPerWindow: parseEnvInt("FRAUD_MAX_REQUESTS_PER_WINDOW", 5),
    windowMs: parseEnvInt("FRAUD_WINDOW_MS", 60_000),
    largeAmountStroops: BigInt(
      parseEnvInt("FRAUD_LARGE_AMOUNT_STROOPS", 100_000_000_000)
    ),
    buyerAllowlist: allowlist,
  };
}

// Reload config lazily so tests can override env vars before the first call.
let _config: FraudConfig | null = null;
export function getConfig(): FraudConfig {
  if (!_config) _config = loadConfig();
  return _config;
}

/** Re-read environment variables. Useful in tests. */
export function resetConfig(): void {
  _config = null;
}

// ---------------------------------------------------------------------------
// Velocity tracker (sliding-window per buyer)
// ---------------------------------------------------------------------------

/** Timestamps of recent requests, keyed by buyer address. */
const velocityStore = new Map<string, number[]>();

/**
 * Record a new request for `buyer` and return the count of requests that fall
 * inside the current window.
 */
function recordAndCount(buyer: string, nowMs: number, windowMs: number): number {
  const cutoff = nowMs - windowMs;
  const timestamps = velocityStore.get(buyer) ?? [];

  // Prune entries outside the window
  const recent = timestamps.filter((t) => t > cutoff);
  recent.push(nowMs);
  velocityStore.set(buyer, recent);
  return recent.length;
}

// ---------------------------------------------------------------------------
// Fraud flag store
// ---------------------------------------------------------------------------

export interface FraudFlag {
  tradeId: string;
  buyer: string;
  seller: string;
  amountStroops: string;
  reasons: string[];
  windowCount: number;
  flaggedAt: string; // ISO-8601
}

const flagStore: FraudFlag[] = [];

export function getFraudFlags(): FraudFlag[] {
  return flagStore.slice(); // return a shallow copy
}

/** Wipe the flag store. Used in tests. */
export function clearFraudFlags(): void {
  flagStore.length = 0;
}

/** Wipe velocity state. Used in tests. */
export function clearVelocityStore(): void {
  velocityStore.clear();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FraudCheckInput {
  tradeId: string;
  buyer: string;
  seller: string;
  amountStroops: string;
}

export interface FraudCheckResult {
  flagged: boolean;
  reasons: string[];
  windowCount: number;
}

/**
 * Evaluate a cash request for fraud signals.
 *
 * This function is **non-blocking** — it never throws and never prevents the
 * request from proceeding.  Callers should log the result and surface flags
 * through the admin endpoint.
 */
export function checkFraud(
  input: FraudCheckInput,
  nowMs: number = Date.now()
): FraudCheckResult {
  const config = getConfig();
  const reasons: string[] = [];

  // Whitelisted buyers bypass all checks
  if (config.buyerAllowlist.has(input.buyer)) {
    return { flagged: false, reasons: [], windowCount: 0 };
  }

  // 1. Velocity check
  const windowCount = recordAndCount(input.buyer, nowMs, config.windowMs);
  if (windowCount > config.maxRequestsPerWindow) {
    reasons.push(
      `velocity: ${windowCount} requests in ${config.windowMs}ms window (max ${config.maxRequestsPerWindow})`
    );
  }

  // 2. Large-amount check
  if (config.largeAmountStroops > 0n) {
    let amount = 0n;
    try {
      amount = BigInt(input.amountStroops);
    } catch {
      // unparseable amount — already validated upstream, so ignore here
    }
    if (amount > config.largeAmountStroops) {
      reasons.push(
        `large_amount: ${input.amountStroops} stroops exceeds threshold ${config.largeAmountStroops}`
      );
    }
  }

  const flagged = reasons.length > 0;

  if (flagged) {
    const flag: FraudFlag = {
      tradeId: input.tradeId,
      buyer: input.buyer,
      seller: input.seller,
      amountStroops: input.amountStroops,
      reasons,
      windowCount,
      flaggedAt: new Date(nowMs).toISOString(),
    };
    flagStore.push(flag);
  }

  return { flagged, reasons, windowCount };
}
