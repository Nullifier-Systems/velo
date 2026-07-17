const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export interface CashRequestStatus {
  id: string;
  contractId: string;
  seller: string;
  buyer: string;
  amountStroops: string;
  secretHashHex: string;
  status: "locked" | "released" | "refunded";
  createdAt: string;
}

export async function fetchCashRequest(id: string): Promise<CashRequestStatus> {
  const res = await fetch(`${API_BASE}/api/v1/cash/request/${id}`);
  if (!res.ok) {
    throw new Error(res.status === 404 ? "not-found" : `request failed (${res.status})`);
  }
  return res.json();
}

export async function releaseCashRequest(id: string, secret: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/cash/request/${id}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `release failed (${res.status})`);
  }
}

/** Formats a stroop amount (7 decimal places) as a human-readable string. */
export function formatStroops(stroops: string): string {
  const n = BigInt(stroops);
  const whole = n / 10_000_000n;
  const frac = (n % 10_000_000n).toString().padStart(7, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

/** Truncates a long address/ID to its first and last 5 characters. */
export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-5)}` : addr;
}
