import { useTranslation } from "react-i18next";

/** Approximate Stellar ledger close time, mirrors apps/api AVERAGE_LEDGER_CLOSE_SECONDS. */
const LEDGER_CLOSE_SECONDS = 6;

/** Mirrors SWAP_DISPUTE_WARNING_MARGIN_LEDGERS in apps/api/src/lib/timeouts.ts. */
const DEFAULT_WARNING_MARGIN_LEDGERS = 50;

/** Mirrors swap_dispute_state in migration 029. */
export type SwapDisputeState =
  | "ACTIVE"
  | "SECRET_EXTRACTED"
  | "REFUND_CLAIMABLE"
  | "RESOLVED";

export interface AtomicSwapDisputeCardProps {
  swapId: string;
  counterpartyAddress: string;
  /** Ledger at which this leg's HTLC timeout elapses. */
  expirationLedger: number;
  /** Current chain tip. */
  latestLedger: number;
  state: SwapDisputeState;
  /** Present once a preimage has been extracted from either chain. */
  secretPreimage?: string | null;
  /** Ledgers of margin before expiry at which the card starts warning. */
  warningMarginLedgers?: number;
  /** Invoked by the claim button. Absent renders the card read-only. */
  onClaimRefund?: () => void;
  /** True while a claim is in flight, so the button cannot be double-fired. */
  claiming?: boolean;
}

function shortenAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Live status of one leg of a cross-chain HTLC swap, and the honest party's
 * escape hatch when the counterparty stalls.
 *
 * Three things a counterparty needs to see, in order of urgency:
 *
 *   * whether the secret has been extracted — once it has, the swap settles
 *     and there is nothing to dispute;
 *   * how long the lockup has left before a refund unlocks;
 *   * a one-click claim, enabled only once the chain would actually accept it.
 *
 * The claim button's enabled condition mirrors the contract precondition
 * (`latestLedger >= expirationLedger`), so the UI never offers an action the
 * chain would reject.
 */
export default function AtomicSwapDisputeCard({
  swapId,
  counterpartyAddress,
  expirationLedger,
  latestLedger,
  state,
  secretPreimage = null,
  warningMarginLedgers = DEFAULT_WARNING_MARGIN_LEDGERS,
  onClaimRefund,
  claiming = false,
}: AtomicSwapDisputeCardProps) {
  const { t } = useTranslation();

  const ledgersUntilExpiry = Math.max(0, expirationLedger - latestLedger);
  const expired = latestLedger >= expirationLedger;
  const secretExtracted = state === "SECRET_EXTRACTED" || Boolean(secretPreimage);
  const resolved = state === "RESOLVED";
  const approachingExpiry = !expired && ledgersUntilExpiry <= warningMarginLedgers;

  // A swap whose secret is out settles with that preimage — refunding it would
  // hand the funds back while the counterparty can still take the other leg.
  const refundClaimable = expired && !secretExtracted && !resolved;
  const secondsUntilExpiry = ledgersUntilExpiry * LEDGER_CLOSE_SECONDS;

  const statusLabel = resolved
    ? t("swapDispute.status.resolved", "Resolved")
    : secretExtracted
      ? t("swapDispute.status.secretExtracted", "Secret extracted — settling")
      : refundClaimable
        ? t("swapDispute.status.refundClaimable", "Timed out — refund available")
        : approachingExpiry
          ? t("swapDispute.status.approachingExpiry", "Expiring soon")
          : t("swapDispute.status.active", "Locked — awaiting counterparty");

  const statusTone = resolved
    ? "#6b7280"
    : secretExtracted
      ? "#047857"
      : refundClaimable
        ? "#b45309"
        : approachingExpiry
          ? "#b45309"
          : "#1d4ed8";

  return (
    <section
      role="group"
      aria-label={t("swapDispute.cardLabel", "Atomic swap dispute status")}
      data-testid="atomic-swap-dispute-card"
      data-state={state}
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>
            {t("swapDispute.swapId", "Swap")}
          </div>
          <code data-testid="swap-dispute-id" style={{ fontSize: 13 }}>
            {shortenAddress(swapId)}
          </code>
        </div>
        <span
          role="status"
          aria-live="polite"
          data-testid="swap-dispute-status"
          style={{ color: statusTone, fontWeight: 600, fontSize: 13 }}
        >
          {statusLabel}
        </span>
      </header>

      <div style={{ fontSize: 13, color: "#374151" }}>
        {t("swapDispute.counterparty", "Counterparty")}:{" "}
        <code>{shortenAddress(counterpartyAddress)}</code>
      </div>

      {/* Lockup countdown. Ledger counts are the source of truth; the time
          estimate is a convenience and never gates the claim. */}
      <div data-testid="swap-dispute-countdown" style={{ fontSize: 13 }}>
        {expired
          ? t("swapDispute.expired", "Lockup expired at ledger {{ledger}}", {
              ledger: expirationLedger,
            })
          : t(
              "swapDispute.countdown",
              "{{ledgers}} ledger(s) until refund unlocks (~{{seconds}}s)",
              { ledgers: ledgersUntilExpiry, seconds: secondsUntilExpiry },
            )}
      </div>

      {/* Secret extraction progress — the reassurance that the preimage is
          stored off-chain and the counterpart leg is claimable. */}
      <div data-testid="swap-dispute-secret-progress" style={{ fontSize: 13 }}>
        {secretExtracted
          ? t("swapDispute.secretStored", "Secret extracted and stored off-chain")
          : t("swapDispute.secretPending", "No secret revealed yet on either chain")}
      </div>

      {onClaimRefund && (
        <button
          type="button"
          data-testid="swap-dispute-claim-button"
          onClick={onClaimRefund}
          disabled={!refundClaimable || claiming}
          aria-disabled={!refundClaimable || claiming}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "none",
            fontWeight: 600,
            cursor: refundClaimable && !claiming ? "pointer" : "not-allowed",
            opacity: refundClaimable && !claiming ? 1 : 0.5,
            background: "#b45309",
            color: "#ffffff",
          }}
        >
          {claiming
            ? t("swapDispute.claiming", "Claiming…")
            : t("swapDispute.claimRefund", "Claim Dispute Refund")}
        </button>
      )}
    </section>
  );
}
