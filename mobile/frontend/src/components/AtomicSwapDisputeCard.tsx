import React, { useState } from "react";

export interface AtomicSwapDisputeCardProps {
  swapId: string;
  initiatorAddress: string;
  counterpartyAddress: string;
  amountUsdc: string;
  secretHash: string;
  expirationLedger: number;
  currentLedger: number;
  state: "ACTIVE" | "SECRET_EXTRACTED" | "REFUND_CLAIMABLE" | "RESOLVED";
  secretPreimage?: string | null;
  onClaimRefund?: (swapId: string) => Promise<void> | void;
  onExtractSecret?: (swapId: string, secret: string) => Promise<void> | void;
}

export const AtomicSwapDisputeCard: React.FC<AtomicSwapDisputeCardProps> = ({
  swapId,
  initiatorAddress,
  counterpartyAddress,
  amountUsdc,
  secretHash,
  expirationLedger,
  currentLedger,
  state,
  secretPreimage,
  onClaimRefund,
  onExtractSecret,
}) => {
  const [revealedSecret, setRevealedSecret] = useState("");
  const [loading, setLoading] = useState(false);

  const ledgersRemaining = Math.max(0, expirationLedger - currentLedger);
  const isExpired = currentLedger >= expirationLedger;
  const isRefundClaimable = isExpired && state !== "RESOLVED";
  const secondsRemaining = ledgersRemaining * 5;

  const handleClaim = async () => {
    if (!onClaimRefund || loading) return;
    setLoading(true);
    try {
      await onClaimRefund(swapId);
    } finally {
      setLoading(false);
    }
  };

  const handleExtract = async () => {
    if (!onExtractSecret || !revealedSecret || loading) return;
    setLoading(true);
    try {
      await onExtractSecret(swapId, revealedSecret);
      setRevealedSecret("");
    } finally {
      setLoading(false);
    }
  };

  const getBadgeColor = () => {
    switch (state) {
      case "RESOLVED":
        return "#16a34a"; // green
      case "SECRET_EXTRACTED":
        return "#2563eb"; // blue
      case "REFUND_CLAIMABLE":
        return "#dc2626"; // red
      case "ACTIVE":
      default:
        return isRefundClaimable ? "#dc2626" : "#b45309"; // amber
    }
  };

  const getStatusLabel = () => {
    if (state === "RESOLVED") return "Resolved / Completed";
    if (state === "SECRET_EXTRACTED") return "Secret Extracted (Ready to Settle)";
    if (isRefundClaimable || state === "REFUND_CLAIMABLE") return "Refund Claimable";
    return "Locked / Active";
  };

  return (
    <div
      role="region"
      aria-label="Atomic Swap Dispute Card"
      data-testid="atomic-swap-dispute-card"
      style={{
        border: `1px solid ${getBadgeColor()}`,
        borderRadius: "12px",
        padding: "20px",
        backgroundColor: "rgba(255, 255, 255, 0.04)",
        boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
        color: "inherit",
        fontFamily: "inherit",
        maxWidth: "600px",
        margin: "12px 0",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "16px",
          borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
          paddingBottom: "12px",
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700 }}>
            Cross-Ledger Atomic Swap Bridge
          </h3>
          <span style={{ fontSize: "0.75rem", opacity: 0.7, fontFamily: "monospace" }}>
            ID: {swapId.slice(0, 16)}...{swapId.slice(-8)}
          </span>
        </div>
        <span
          data-testid="swap-status-badge"
          style={{
            padding: "4px 10px",
            borderRadius: "999px",
            fontSize: "0.75rem",
            fontWeight: 700,
            color: "#ffffff",
            backgroundColor: getBadgeColor(),
          }}
        >
          {getStatusLabel()}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "12px",
          fontSize: "0.85rem",
          marginBottom: "16px",
        }}
      >
        <div>
          <strong style={{ display: "block", opacity: 0.6 }}>Amount</strong>
          <span>{amountUsdc} USDC</span>
        </div>
        <div>
          <strong style={{ display: "block", opacity: 0.6 }}>Lock Status</strong>
          <span>
            {isExpired ? (
              <span style={{ color: "#ef4444", fontWeight: 600 }}>Expired (Timeout Reached)</span>
            ) : (
              `${ledgersRemaining} ledgers (~${secondsRemaining}s)`
            )}
          </span>
        </div>
        <div style={{ gridColumn: "span 2" }}>
          <strong style={{ display: "block", opacity: 0.6 }}>Initiator</strong>
          <span style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>
            {initiatorAddress}
          </span>
        </div>
        <div style={{ gridColumn: "span 2" }}>
          <strong style={{ display: "block", opacity: 0.6 }}>Counterparty</strong>
          <span style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>
            {counterpartyAddress}
          </span>
        </div>
        <div style={{ gridColumn: "span 2" }}>
          <strong style={{ display: "block", opacity: 0.6 }}>Secret Hash</strong>
          <span style={{ fontFamily: "monospace", fontSize: "0.75rem", wordBreak: "break-all" }}>
            {secretHash}
          </span>
        </div>
        {secretPreimage && (
          <div style={{ gridColumn: "span 2", background: "rgba(37, 99, 235, 0.1)", padding: "8px", borderRadius: "6px" }}>
            <strong style={{ display: "block", color: "#60a5fa" }}>Extracted Secret Preimage</strong>
            <span style={{ fontFamily: "monospace", fontSize: "0.75rem", wordBreak: "break-all" }}>
              {secretPreimage}
            </span>
          </div>
        )}
      </div>

      {state !== "RESOLVED" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", gap: "8px" }}>
            <input
              type="text"
              placeholder="Enter revealed secret hex..."
              value={revealedSecret}
              onChange={(e) => setRevealedSecret(e.target.value)}
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: "6px",
                border: "1px solid rgba(255, 255, 255, 0.2)",
                background: "rgba(0, 0, 0, 0.2)",
                color: "inherit",
                fontSize: "0.8rem",
              }}
            />
            <button
              onClick={handleExtract}
              disabled={loading || !revealedSecret}
              style={{
                padding: "8px 14px",
                borderRadius: "6px",
                backgroundColor: "#0284c7",
                color: "#ffffff",
                fontWeight: 600,
                cursor: loading || !revealedSecret ? "not-allowed" : "pointer",
                opacity: loading || !revealedSecret ? 0.6 : 1,
              }}
            >
              Extract Secret
            </button>
          </div>

          <button
            data-testid="claim-dispute-refund-button"
            onClick={handleClaim}
            disabled={!isRefundClaimable || loading}
            style={{
              width: "100%",
              padding: "10px 16px",
              borderRadius: "8px",
              backgroundColor: isRefundClaimable ? "#dc2626" : "rgba(255, 255, 255, 0.1)",
              color: isRefundClaimable ? "#ffffff" : "rgba(255, 255, 255, 0.4)",
              fontWeight: 700,
              fontSize: "0.9rem",
              cursor: isRefundClaimable && !loading ? "pointer" : "not-allowed",
              transition: "background-color 0.2s",
            }}
          >
            {loading
              ? "Processing..."
              : isRefundClaimable
                ? "Claim Dispute Refund"
                : `Refund Locked (${ledgersRemaining} ledgers left)`}
          </button>
        </div>
      )}
    </div>
  );
};
