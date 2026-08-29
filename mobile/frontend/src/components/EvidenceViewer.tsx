import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface EvidenceFile {
  id: string;
  tradeId: string;
  uploadedBy: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  merkleRoot: string;
}

interface EvidenceViewerProps {
  tradeId: string;
  onClose: () => void;
}

export default function EvidenceViewer({ tradeId, onClose }: EvidenceViewerProps) {
  const { t } = useTranslation();
  const [evidence, setEvidence] = useState<EvidenceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchEvidence = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
        const res = await fetch(`${apiUrl}/api/v1/cash/request/${tradeId}/evidence`);
        if (!res.ok) throw new Error("Failed to fetch evidence");
        const data = await res.json();
        setEvidence(data.data || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };
    void fetchEvidence();
  }, [tradeId]);

  return (
    <div style={{
      backgroundColor: "#1e1e2e",
      color: "#cdd6f4",
      padding: "24px",
      borderRadius: "12px",
      maxWidth: "600px",
      width: "100%",
    }}>
      <h3 style={{ marginTop: 0, color: "#f9e2af" }}>{t("juryArbitration.evidenceViewer.title")}</h3>

      {loading && <p style={{ fontStyle: "italic" }}>{t("juryArbitration.evidenceViewer.loading")}</p>}
      {error && (
        <div style={{ color: "#f38ba8", padding: "8px", borderRadius: "6px", backgroundColor: "#45475a" }}>
          {error}
        </div>
      )}

      {!loading && evidence.length === 0 && (
        <p style={{ color: "#6c7086" }}>{t("juryArbitration.evidenceViewer.empty")}</p>
      )}

      {evidence.map((file) => (
        <div
          key={file.id}
          style={{
            backgroundColor: "#313244",
            padding: "12px",
            borderRadius: "8px",
            marginBottom: "8px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: "bold" }}>{file.fileName}</div>
            <div style={{ fontSize: "0.8rem", color: "#6c7086" }}>
              {file.contentType} · {(file.sizeBytes / 1024).toFixed(1)} {t("juryArbitration.evidenceViewer.kb")}
            </div>
            <div style={{ fontSize: "0.75rem", color: "#585b70" }}>
              {t("juryArbitration.evidenceViewer.uploadedBy")} {file.uploadedBy.slice(0, 8)}... · {new Date(file.createdAt).toLocaleString()}
            </div>
          </div>
          <div style={{ fontSize: "0.7rem", color: "#45475a", fontFamily: "monospace", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis" }}>
            {t("juryArbitration.evidenceViewer.merkle")} {file.merkleRoot.slice(0, 12)}...
          </div>
        </div>
      ))}

      <button
        onClick={onClose}
        style={{
          marginTop: "16px",
          padding: "8px 16px",
          borderRadius: "6px",
          border: "1px solid #45475a",
          backgroundColor: "transparent",
          color: "#cdd6f4",
          cursor: "pointer",
        }}
      >
        {t("juryArbitration.evidenceViewer.close")}
      </button>
    </div>
  );
}
