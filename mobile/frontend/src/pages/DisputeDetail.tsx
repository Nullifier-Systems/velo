import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import EvidenceViewer from "../components/EvidenceViewer.js";
import EvidenceRedactionPreview from "../components/EvidenceRedactionPreview.js";

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
  const { t } = useTranslation();
  const [dispute, setDispute] = useState<DisputeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [showUploadPreview, setShowUploadPreview] = useState(false);

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
        <p style={{ fontStyle: "italic" }}>{t("juryArbitration.disputeDetail.loading")}</p>
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
          {t("juryArbitration.disputeDetail.back")}
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
        {t("juryArbitration.disputeDetail.backToDashboard")}
      </button>

      <h1 style={{ color: "#cba6f7" }}>{t("juryArbitration.disputeDetail.title")}</h1>

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
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>{t("juryArbitration.disputeDetail.tradeId")}</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.9rem" }}>{dispute.tradeId.slice(0, 16)}...</div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>{t("juryArbitration.disputeDetail.status")}</div>
              <div style={{
                fontWeight: "bold",
                color: dispute.status === "disputed" ? "#f9e2af" : "#a6e3a1",
              }}>
                {dispute.status}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>{t("juryArbitration.disputeDetail.buyer")}</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>
                {dispute.buyer.slice(0, 12)}...
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>{t("juryArbitration.disputeDetail.seller")}</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>
                {dispute.seller.slice(0, 12)}...
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>{t("juryArbitration.disputeDetail.amount")}</div>
              <div style={{ fontWeight: "bold" }}>
                {(Number(dispute.amountStroops) / STROOPS_PER_USDC).toFixed(2)} {t("juryArbitration.disputeDetail.usdc")}
              </div>
            </div>
            {dispute.panelId && (
              <div>
                <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>{t("juryArbitration.disputeDetail.juryPanel")}</div>
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
              <div style={{ fontSize: "0.85rem", color: "#6c7086" }}>{t("juryArbitration.disputeDetail.resolution")}</div>
              <div style={{
                fontWeight: "bold",
                fontSize: "1.1rem",
                color: dispute.resolution === "BUYER" ? "#a6e3a1" : dispute.resolution === "SELLER" ? "#89b4fa" : "#f9e2af",
              }}>
                {dispute.resolution === "BUYER"
                  ? `Resolved in favor of Buyer (${dispute.buyerShareBps ?? 10000} bps)`
                  : dispute.resolution === "SELLER"
                    ? `Resolved in favor of Seller (${((dispute.buyerShareBps ?? 0) / 100).toFixed(0)}% to Buyer)`
                    : t("juryArbitration.disputeDetail.tiedSplit")}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: "12px" }}>
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
          {t("juryArbitration.disputeDetail.viewEvidenceFiles")}
        </button>
        <button
          onClick={() => setShowUploadPreview(true)}
          style={{
            padding: "10px 20px",
            borderRadius: "8px",
            border: "none",
            backgroundColor: "#89b4fa",
            color: "#11111b",
            cursor: "pointer",
            fontWeight: "bold",
          }}
        >
          {t('disputeEvidence.uploadPreview.uploadEvidenceBtn')}
        </button>
      </div>

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

      {showUploadPreview && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0,0,0,0.8)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
        }}>
          <EvidenceRedactionPreview 
            tradeId={tradeId} 
            onCancel={() => setShowUploadPreview(false)} 
            onUploadSuccess={() => setShowUploadPreview(false)} 
          />
        </div>
      )}
    </div>
  );
}
