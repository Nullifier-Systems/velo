import React, { useState, useEffect } from "react";
import EvidenceViewer from "../components/EvidenceViewer.js";

interface DisputeDetailProps {
  tradeId: string;
  onBack: () => void;
}

interface DisputeInfo {
  tradeId: string;
  status: string;
  buyer: string;
  seller: string;
  amountStroops: string;
  panelId?: string;
  panelStatus?: string;
  resolution?: string;
  buyerShareBps?: number;
}

export default function DisputeDetail({ tradeId, onBack }: DisputeDetailProps) {
  const [dispute, setDispute] = useState<DisputeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);

  const STROOPS_PER_USDC = 10_000_000;

  useEffect(() => {
    const fetchDispute = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
        const res = await fetch(`${apiUrl}/api/v1/cash/request/${tradeId}`);
        if (!res.ok) throw new Error("Failed to fetch dispute details");
        const data = await res.json();
        setDispute({
          tradeId,
          status: data.status,
          buyer: data.buyer,
          seller: data.seller,
          amountStroops: data.amount_stroops,
          panelId: data.panel_id,
          panelStatus: data.panel_status,
          resolution: data.resolution,
          buyerShareBps: data.buyer_share_bps,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };
    void fetchDispute();
  }, [tradeId]);

  if (loading) {
    return (
      <div style={{ backgroundColor: "#11111b", color: "#cdd6f4", padding: "24px" }}>
        <p style={{ fontStyle: "italic" }}>Loading dispute details...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ backgroundColor: "#11111b", color: "#cdd6f4", padding: "24px" }}>
        <div style={{ color: "#f38ba8", padding: "12px", borderRadius: "6px", backgroundColor: "#45475a" }}>
          {error}
        </div>
        <button onClick={onBack} style={{ marginTop: "12px", cursor: "pointer" }}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: "#11111b", color: "#cdd6f4", minHeight: "100vh", padding: "24px" }}>
      <button
        onClick={onBack}
        style={{
          background: "none",
          border: "none",
          color: "#89b4fa",
          cursor: "pointer",
          fontSize: "0.9rem",
          marginBottom: "16px",
        }}
      >
        &larr; Back to Dashboard
      </button>

      <h1 style={{ color: "#cba6f7" }}>Dispute Detail</h1>

      {dispute && (
        <div style={{
          backgroundColor: "#1e1e2e",
          padding: "20px",
          borderRadius: "12px",
          border: "1px solid #313244",
          marginBottom: "20px",
        }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>Trade ID</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.9rem" }}>{dispute.tradeId.slice(0, 16)}...</div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>Status</div>
              <div style={{
                fontWeight: "bold",
                color: dispute.status === "disputed" ? "#f9e2af" : "#a6e3a1",
              }}>
                {dispute.status}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>Buyer</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>
                {dispute.buyer.slice(0, 12)}...
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>Seller</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>
                {dispute.seller.slice(0, 12)}...
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>Amount</div>
              <div style={{ fontWeight: "bold" }}>
                {(Number(dispute.amountStroops) / STROOPS_PER_USDC).toFixed(2)} USDC
              </div>
            </div>
            {dispute.panelId && (
              <div>
                <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>Jury Panel</div>
                <div style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>
                  {dispute.panelId.slice(0, 12)}...
                </div>
              </div>
            )}
          </div>

          {dispute.resolution && (
            <div style={{
              marginTop: "16px",
              padding: "12px",
              borderRadius: "8px",
              backgroundColor: "#313244",
            }}>
              <div style={{ fontSize: "0.85rem", color: "#6c7086" }}>Resolution</div>
              <div style={{
                fontWeight: "bold",
                fontSize: "1.1rem",
                color: dispute.resolution === "BUYER" ? "#a6e3a1" : dispute.resolution === "SELLER" ? "#89b4fa" : "#f9e2af",
              }}>
                {dispute.resolution === "BUYER"
                  ? `Resolved in favor of Buyer (${dispute.buyerShareBps ?? 10000} bps)`
                  : dispute.resolution === "SELLER"
                    ? `Resolved in favor of Seller (${((dispute.buyerShareBps ?? 0) / 100).toFixed(0)}% to Buyer)`
                    : "Tied - Split 50/50"}
              </div>
            </div>
          )}
        </div>
      )}

      <button
        onClick={() => setShowEvidence(true)}
        style={{
          padding: "10px 20px",
          borderRadius: "8px",
          border: "1px solid #f9e2af",
          backgroundColor: "transparent",
          color: "#f9e2af",
          cursor: "pointer",
          fontWeight: "bold",
        }}
      >
        View Evidence Files
      </button>

      {showEvidence && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0,0,0,0.6)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9998,
        }}>
          <EvidenceViewer tradeId={tradeId} onClose={() => setShowEvidence(false)} />
        </div>
      )}
    </div>
  );
}
