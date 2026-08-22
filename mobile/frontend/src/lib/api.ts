const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

/** Generate a unique idempotency key for offline-safe mutations. */
function createIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

export interface TrancheInfo {
  amount: string;
  secretHashHex: string;
  released: boolean;
}

export interface CashRequestStatus {
  id: string;
  contractId: string;
  seller: string;
  buyer: string;
  amountStroops: string;
  secretHashHex: string;
  status: "locked" | "expired" | "released" | "refunded";
  createdAt: string;
  timeoutLedger?: number;
  /** Chain tip used for the refund countdown (locked/expired). */
  latestLedger?: number;
  /** Ledgers remaining before permissionless refund; 0 when available. */
  ledgersUntilRefund?: number;
  /** True once latestLedger >= timeoutLedger. */
  refundAvailable?: boolean;
  /** Wall-clock estimate only (ledgers × ~6s). */
  estimatedSecondsUntilRefund?: number;
  /** Tranches for partial/incremental releases */
  tranches?: TrancheInfo[];
  /** Count of released tranches */
  releasedTranchesCount?: number;
  /** Total amount released so far (sum of released tranches) */
  releasedAmount?: string;
}

export type ReleaseFailureKind = "uncertain" | "failed";

export class ReleaseRequestError extends Error {
  constructor(
    message: string,
    readonly kind: ReleaseFailureKind,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ReleaseRequestError";
  }
}

export function isUncertainReleaseError(error: unknown): error is ReleaseRequestError {
  return error instanceof ReleaseRequestError && error.kind === "uncertain";
}

export class GatewayTimeoutError extends Error {
  constructor(
    message: string,
    readonly requestId: string,
    readonly operation?: string,
    readonly elapsedMs?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "GatewayTimeoutError";
  }
}

export function isGatewayTimeoutError(error: unknown): error is GatewayTimeoutError {
  return error instanceof GatewayTimeoutError;
}

export async function fetchCashRequest(id: string): Promise<CashRequestStatus> {
  const res = await fetch(`${API_BASE}/api/v1/cash/request/${id}`);
  if (!res.ok) {
    if (res.status === 504) {
      const body = await res.json().catch(() => ({} as { error?: { code?: string; message?: string; requestId?: string } }));
      if (body.error?.code === "GATEWAY_TIMEOUT") {
        throw new GatewayTimeoutError(
          body.error.message || "The payment network request timed out. Please retry your operation.",
          body.error.requestId || "unknown",
          body.error.operation,
          body.error.elapsed_ms
        );
      }
    }
    throw new Error(res.status === 404 ? "not-found" : `request failed (${res.status})`);
  }
  return res.json();
}

/** Submit permissionless refund once the escrow timeout has elapsed. */
export async function refundCashRequest(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/cash/request/${id}/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error ?? `refund failed (${res.status})`);
  }
}

export async function releaseCashRequest(id: string, secret: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/cash/request/${id}/release`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-idempotency-key": createIdempotencyKey(),
      },
      body: JSON.stringify({ secret }),
    });
  } catch (cause) {
    // Offline: queue the mutation for later sync (#305)
    try {
      const { queueMutation } = await import("./sync/queue");
      await queueMutation({
        endpoint: `/api/v1/cash/request/${id}/release`,
        method: "POST",
        body: { secret },
        idempotencyKey: createIdempotencyKey(),
      });
    } catch {
      // Silently handle queue failure — will retry on next sync
    }

    throw new ReleaseRequestError(
      "The connection ended before Velo could confirm the release. It has been queued for sync.",
      "uncertain",
      { cause }
    );
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }));
    const message = body.error ?? `release failed (${res.status})`;
    const kind: ReleaseFailureKind =
      res.status >= 500 || body.error === "rpc_timeout" ? "uncertain" : "failed";
    throw new ReleaseRequestError(message, kind);
  }
}

/**
 * Safely retry an uncertain release.
 *
 * The release endpoint is idempotent for an already-released request. Checking
 * status first avoids an unnecessary second POST; a concurrent release between
 * this GET and POST is still handled by the endpoint's released-state guard.
 */
export async function reconcileAndRetryRelease(
  id: string,
  secret: string
): Promise<"already_released" | "released"> {
  let current: CashRequestStatus;
  try {
    current = await fetchCashRequest(id);
  } catch (cause) {
    throw new ReleaseRequestError(
      "Velo could not verify the current release status. No retry was sent.",
      "uncertain",
      { cause }
    );
  }

  if (current.status === "released") return "already_released";
  if (current.status !== "locked") {
    throw new ReleaseRequestError(
      `This request is ${current.status} and cannot be released.`,
      "failed"
    );
  }

  await releaseCashRequest(id, secret);
  return "released";
}

export interface ChatMessage {
  id: string;
  tradeId: string;
  sender: string;
  ciphertext: string;
  nonce: string;
  createdAt: string;
}

export async function fetchChatHistory(tradeId: string, token: string, after?: string): Promise<{ messages: ChatMessage[] }> {
  const suffix = after ? `?after=${encodeURIComponent(after)}` : "";
  const res = await fetch(`${API_BASE}/api/v1/chat/${tradeId}/history${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("chat history failed");
  return res.json();
}

export interface KeyEntry {
  publicKey: string;
  updatedAt: string;
}

export async function publishChatKey(tradeId: string, token: string, publicKey: string): Promise<KeyEntry> {
  const res = await fetch(
    `${API_BASE}/api/v1/chat/${tradeId}/keys`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ publicKey }),
    }
  );
  if (!res.ok) throw new Error("publishing chat key failed");
  return res.json();
}

/** Formats a stroop amount (7 decimal places) as a human-readable string. */
export function formatStroops(stroops: string): string {
  const n = BigInt(stroops);
  const whole = n / 10_000_000n;
  const frac = (n % 10_000_000n).toString().padStart(7, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

export interface StatusResponse {
  api: { status: string; uptime_seconds: number; timestamp: string };
  chain: { network: string; status: string; latest_ledger: number | null };
  recent_activity: { id: string; status: string; createdAt: string }[];
}

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch(`${API_BASE}/api/v1/status`);
  if (!res.ok) throw new Error("status check failed");
  return res.json();
}

/** Formats a remaining-seconds estimate as a short countdown label. */
export function formatRefundCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds <= 0) return "0s";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs.toString().padStart(2, "0")}s`;
  return `${secs}s`;
}

export interface EscrowPauseState {
  paused: boolean;
  pause_effective_ledger: number | null;
  pause_delay_ledgers: number;
  message: string | null;
}

/** Reads the on-chain emergency pause / circuit breaker state (issue #266). */
export async function fetchEscrowPauseState(): Promise<EscrowPauseState> {
  const res = await fetch(`${API_BASE}/api/v1/cash/pause`);
  if (!res.ok) throw new Error(`pause status failed (${res.status})`);
  return res.json();
}

/** Truncates a long address/ID to its first and last 5 characters. */
export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-5)}` : addr;
}
