import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const apiBase = import.meta.env.VITE_API_URL ?? "";

export type BatchAuctionPhase = "COMMIT" | "REVEAL" | "MATCH" | "SETTLE" | "CLOSED";

export interface BatchAuctionState {
  roundId: string;
  phase: BatchAuctionPhase;
  commitDeadline: string;
  revealDeadline: string;
  clearingPriceStroops: string | null;
}

interface HistoryEntry {
  roundId: string;
  clearingPriceStroops: string;
}

/** Seconds remaining until `deadline`, floored at 0. */
export function secondsUntil(deadline: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
}

/**
 * BatchAuctionModal — shows the current commit-reveal batch round's phase
 * timer, this device's encrypted submission status, and a short history of
 * past rounds' uniform clearing prices (#403).
 */
export default function BatchAuctionModal({
  open,
  onClose,
  submitted = false,
  pollIntervalMs = 1_000,
}: {
  open: boolean;
  onClose: () => void;
  /** Whether this client has already committed an order into the open round. */
  submitted?: boolean;
  pollIntervalMs?: number;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<BatchAuctionState | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`${apiBase}/api/v1/auctions/state`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        const next: BatchAuctionState = body.data;
        setState(next);
        setError(null);
        setHistory((prev) => {
          if (!next.clearingPriceStroops) return prev;
          if (prev.some((h) => h.roundId === next.roundId)) return prev;
          return [{ roundId: next.roundId, clearingPriceStroops: next.clearingPriceStroops }, ...prev].slice(0, 5);
        });
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    }

    void poll();
    const dataTimer = setInterval(poll, pollIntervalMs);
    const clockTimer = setInterval(() => setNow(Date.now()), 250);
    return () => {
      cancelled = true;
      clearInterval(dataTimer);
      clearInterval(clockTimer);
    };
  }, [open, pollIntervalMs]);

  if (!open) return null;

  const deadline = state?.phase === "REVEAL" ? state.revealDeadline : state?.commitDeadline;
  const remaining = deadline ? secondsUntil(deadline, now) : null;

  return (
    <div role="dialog" aria-modal="true" className="batch-auction-modal-overlay">
      <div className="batch-auction-modal">
        <div className="batch-auction-modal-header">
          <h2>{t("batchAuction.title", "Batch Auction")}</h2>
          <button onClick={onClose} aria-label={t("common.close", "Close")}>
            ×
          </button>
        </div>

        {error && <p className="batch-auction-modal-error">{error}</p>}

        {state && (
          <>
            <p className="batch-auction-modal-phase">
              {t("batchAuction.phase", "Phase")}: <strong>{state.phase}</strong>
              {remaining !== null && state.phase !== "SETTLE" && state.phase !== "CLOSED" && (
                <span> ({remaining}s)</span>
              )}
            </p>

            <p className="batch-auction-modal-status">
              {submitted
                ? t("batchAuction.submitted", "Your order is encrypted and committed to this round.")
                : t("batchAuction.notSubmitted", "No order submitted for this round yet.")}
            </p>

            {history.length > 0 && (
              <div className="batch-auction-modal-history">
                <h3>{t("batchAuction.history", "Recent clearing prices")}</h3>
                <ul>
                  {history.map((h) => (
                    <li key={h.roundId}>{h.clearingPriceStroops} stroops</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
