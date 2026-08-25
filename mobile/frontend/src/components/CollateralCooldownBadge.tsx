import { useTranslation } from "react-i18next";

/** Approximate Stellar ledger close time, mirrors apps/api LEDGER_CLOSE_SECONDS (#420). */
const LEDGER_CLOSE_SECONDS = 5;

/** Default matches the on-chain MIN_COLLATERAL_LOCKUP_LEDGERS enforced by escrow. */
const DEFAULT_COOLDOWN_LEDGERS = 5;

interface CollateralCooldownBadgeProps {
  /** Ledgers left before the provider's collateral can be withdrawn or reallocated. */
  remainingLedgers: number;
  /** Full lockup length, used to render progress (defaults to the on-chain rule). */
  totalLedgers?: number;
}

/**
 * Visualizes the flash-loan collateral cooldown (#420): while active, the
 * provider cannot withdraw or reallocate collateral — e.g.
 * "Locked: 3 Ledgers Remaining (~15s)".
 */
export default function CollateralCooldownBadge({
  remainingLedgers,
  totalLedgers = DEFAULT_COOLDOWN_LEDGERS,
}: CollateralCooldownBadgeProps) {
  const { t } = useTranslation();

  const locked = remainingLedgers > 0;
  const seconds = Math.max(0, remainingLedgers) * LEDGER_CLOSE_SECONDS;
  const elapsedPct = locked
    ? Math.min(100, Math.max(0, ((totalLedgers - remainingLedgers) / totalLedgers) * 100))
    : 100;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="collateral-cooldown-badge"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 12px",
        borderRadius: "999px",
        border: `1px solid ${locked ? "var(--status-locked, #b45309)" : "var(--status-released, #15803d)"}`,
        background: locked ? "rgba(180, 83, 9, 0.08)" : "rgba(21, 128, 61, 0.08)",
        color: locked ? "var(--status-locked, #b45309)" : "var(--status-released, #15803d)",
        fontSize: "0.8rem",
        fontWeight: 600,
        lineHeight: 1.4,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: "currentColor",
          flexShrink: 0,
        }}
      />
      <span>
        {locked
          ? t("dashboard.collateralLocked", { ledgers: remainingLedgers, seconds })
          : t("dashboard.collateralUnlocked")}
      </span>
      <span
        aria-hidden="true"
        style={{
          width: "56px",
          height: "4px",
          borderRadius: "2px",
          overflow: "hidden",
          background: "currentColor",
          opacity: 0.25,
          position: "relative",
          display: "inline-block",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            width: `${elapsedPct}%`,
            background: "currentColor",
            opacity: 1,
            transition: "width 1s ease-out",
          }}
        />
      </span>
    </div>
  );
}
