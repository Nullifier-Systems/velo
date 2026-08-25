import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import EvidenceViewer from "../components/EvidenceViewer.js";
import { JurorVoteModal } from "../components/JurorVoteModal.js";

interface JurorStake {
  jurorAddress: string;
  stakedAmountStroops: string;
  reputationScore: number;
  active: boolean;
}

interface ActivePanel {
  panelId: string;
  tradeId: string;
  status: string;
  escrowAmountStroops: string;
  createdAt: string;
}

export default function JurorPortal() {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [stake, setStake] = useState<JurorStake | null>(null);
  const [panels, setPanels] = useState<ActivePanel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceTradeId, setEvidenceTradeId] = useState<string | null>(null);
  const [voteModal, setVoteModal] = useState<{ panelId: string; jurorAddress: string } | null>(null);

  const STROOPS_PER_USDC = 10_000_000;

  const fetchJurorData = async (addr: string) => {
    setLoading(true);
    setError(null);
    try {
      const apiUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/api/v1/jury/juror/${addr}`);
      if (res.ok) {
        const data = await res.json();
        setStake(data);
        setIsAuthenticated(true);
      }
      // Fetch active panels
      const panelsRes = await fetch(`${apiUrl}/api/v1/jury/panels?juror=${addr}`);
      if (panelsRes.ok) {
        const panelsData = await panelsRes.json();
        setPanels(panelsData.panels || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load juror data");
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div style={{ backgroundColor: "#11111b", color: "#cdd6f4", minHeight: "100vh", padding: "24px" }}>
        <h1 style={{ color: "#cba6f7" }}>{t("juryArbitration.jurorPortal.title")}</h1>
        <p style={{ color: "#6c7086" }}>{t("juryArbitration.jurorPortal.description")}</p>
        <div style={{ display: "flex", gap: "12px", maxWidth: "600px" }}>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t("juryArbitration.jurorPortal.placeholder")}
            style={{
              flex: 1,
              padding: "10px 14px",
              borderRadius: "8px",
              border: "1px solid #45475a",
              backgroundColor: "#313244",
              color: "#cdd6f4",
            }}
          />
          <button
            onClick={() => fetchJurorData(address)}
            disabled={!address || loading}
            style={{
              padding: "10px 20px",
              borderRadius: "8px",
              border: "none",
              backgroundColor: "#cba6f7",
              color: "#11111b",
              cursor: "pointer",
              fontWeight: "bold",
            }}
          >
            {loading ? t("juryArbitration.jurorPortal.loading") : t("juryArbitration.jurorPortal.connect")}
          </button>
        </div>
        {error && (
          <div style={{ marginTop: "16px", color: "#f38ba8" }}>{error}</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: "#11111b", color: "#cdd6f4", minHeight: "100vh", padding: "24px" }}>
      <h1 style={{ color: "#cba6f7" }}>{t("juryArbitration.jurorPortal.title")}</h1>

      {/* Stake Info Card */}
      {stake && (
        <div style={{
          backgroundColor: "#1e1e2e",
          padding: "20px",
          borderRadius: "12px",
          marginBottom: "24px",
          border: "1px solid #313244",
        }}>
          <h2 style={{ marginTop: 0, color: "#f9e2af" }}>{t("juryArbitration.jurorPortal.yourStake")}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>{t("juryArbitration.jurorPortal.stakedAmount")}</div>
              <div style={{ fontSize: "1.2rem", fontWeight: "bold" }}>
                {(Number(stake.stakedAmountStroops) / STROOPS_PER_USDC).toFixed(2)} {t("juryArbitration.jurorPortal.usdc")}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>{t("juryArbitration.jurorPortal.reputation")}</div>
              <div style={{ fontSize: "1.2rem", fontWeight: "bold" }}>
                {stake.reputationScore}/100
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>{t("juryArbitration.jurorPortal.status")}</div>
              <div style={{
                fontSize: "1rem",
                fontWeight: "bold",
                color: stake.active ? "#a6e3a1" : "#f38ba8",
              }}>
                {stake.active ? t("juryArbitration.jurorPortal.active") : t("juryArbitration.jurorPortal.inactive")}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Active Panels */}
      <div style={{ marginBottom: "24px" }}>
        <h2 style={{ color: "#89b4fa" }}>{t("juryArbitration.jurorPortal.yourPanels")}</h2>
        {panels.length === 0 && (
          <p style={{ color: "#6c7086" }}>{t("juryArbitration.jurorPortal.noPanels")}</p>
        )}
        {panels.map((panel) => (
          <div
            key={panel.panelId}
            style={{
              backgroundColor: "#1e1e2e",
              padding: "16px",
              borderRadius: "10px",
              marginBottom: "12px",
              border: "1px solid #313244",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <div style={{ fontWeight: "bold" }}>
                {t("juryArbitration.jurorPortal.panel")} {panel.panelId.slice(0, 8)}...
              </div>
              <div style={{ fontSize: "0.85rem", color: "#6c7086" }}>
                {t("juryArbitration.jurorPortal.tradeLabel")} {panel.tradeId.slice(0, 12)}... · {t("juryArbitration.jurorPortal.statusLabel")} {panel.status}
              </div>
              <div style={{ fontSize: "0.8rem", color: "#585b70" }}>
                {t("juryArbitration.jurorPortal.escrowLabel")} {(Number(panel.escrowAmountStroops) / STROOPS_PER_USDC).toFixed(2)} {t("juryArbitration.jurorPortal.usdc")}
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setEvidenceTradeId(panel.tradeId)}
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "1px solid #f9e2af",
                  backgroundColor: "transparent",
                  color: "#f9e2af",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                }}
              >
                {t("juryArbitration.jurorPortal.viewEvidence")}
              </button>
              {panel.status === "VOTING" && (
                <button
                  onClick={() => setVoteModal({ panelId: panel.panelId, jurorAddress: address })}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "6px",
                    border: "none",
                    backgroundColor: "#cba6f7",
                    color: "#11111b",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                    fontWeight: "bold",
                  }}
                >
                  {t("juryArbitration.jurorPortal.castVote")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Evidence Viewer Modal */}
      {evidenceTradeId && (
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
          <EvidenceViewer
            tradeId={evidenceTradeId}
            onClose={() => setEvidenceTradeId(null)}
          />
        </div>
      )}

      {/* Vote Modal */}
      {voteModal && (
        <JurorVoteModal
          isOpen={true}
          onClose={() => setVoteModal(null)}
          panelId={voteModal.panelId}
          jurorAddress={voteModal.jurorAddress}
        />
      )}
    </div>
  );
}
