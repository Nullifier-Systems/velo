import React, { useState } from "react";
import { useTranslation } from "react-i18next";

interface JurorVoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  panelId: string;
  jurorAddress: string;
}

type VoteStep = "IDLE" | "COMMITTING" | "COMMITTED" | "REVEALING" | "REVEALED" | "ERROR";

export function JurorVoteModal({ isOpen, onClose, panelId, jurorAddress }: JurorVoteModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<VoteStep>("IDLE");
  const [selectedVote, setSelectedVote] = useState<"BUYER" | "SELLER" | "ABSTAIN" | null>(null);
  const [commitHash, setCommitHash] = useState<string | null>(null);
  const [saltHex, setSaltHex] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const generateCommitHash = async (vote: string): Promise<{ hash: string; salt: string }> => {
    const salt = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, "0"),
    ).join("");
    const data = new TextEncoder().encode(`${vote}:${salt}`);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return { hash, salt };
  };

  const handleCommit = async (vote: "BUYER" | "SELLER" | "ABSTAIN") => {
    setStep("COMMITTING");
    setSelectedVote(vote);
    setErrorMessage(null);

    try {
      const { hash, salt } = await generateCommitHash(vote);
      const apiUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/api/v1/jury/vote-commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ panelId, jurorAddress, commitHash: hash }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to submit commit");
      }

      setCommitHash(hash);
      setSaltHex(salt);
      setStep("COMMITTED");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unknown error");
      setStep("ERROR");
    }
  };

  const handleReveal = async () => {
    if (!selectedVote || !saltHex) return;
    setStep("REVEALING");
    setErrorMessage(null);

    try {
      const apiUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/api/v1/jury/vote-reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          panelId,
          jurorAddress,
          vote: selectedVote,
          saltHex,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to reveal vote");
      }

      setStep("REVEALED");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unknown error");
      setStep("ERROR");
    }
  };

  const voteOptions = [
    { value: "BUYER" as const, label: t("juryArbitration.voteModal.ruleForBuyer"), color: "#a6e3a1" },
    { value: "SELLER" as const, label: t("juryArbitration.voteModal.ruleForSeller"), color: "#89b4fa" },
    { value: "ABSTAIN" as const, label: t("juryArbitration.voteModal.abstain"), color: "#6c7086" },
  ];

  return (
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
      zIndex: 9999,
    }}>
      <div style={{
        backgroundColor: "#1e1e2e",
        color: "#cdd6f4",
        padding: "24px",
        borderRadius: "12px",
        maxWidth: "480px",
        width: "90%",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      }}>
        <h3 style={{ marginTop: 0, color: "#cba6f7" }}>{t("juryArbitration.voteModal.title")}</h3>
        <p style={{ fontSize: "0.85rem", color: "#6c7086" }}>
          {t("juryArbitration.voteModal.panelLabel")} {panelId.slice(0, 12)}... | {t("juryArbitration.voteModal.jurorLabel")} {jurorAddress.slice(0, 12)}...
        </p>

        {step === "ERROR" && (
          <div style={{
            backgroundColor: "#f38ba8",
            color: "#11111b",
            padding: "12px",
            borderRadius: "6px",
            marginBottom: "16px",
            fontWeight: "bold",
          }}>
            {errorMessage}
          </div>
        )}

        {step === "REVEALED" && (
          <div style={{
            backgroundColor: "#a6e3a1",
            color: "#11111b",
            padding: "12px",
            borderRadius: "6px",
            marginBottom: "16px",
            textAlign: "center",
            fontWeight: "bold",
          }}>
            {t("juryArbitration.voteModal.revealSuccess")}
          </div>
        )}

        {step === "IDLE" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "16px" }}>
            {voteOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleCommit(opt.value)}
                style={{
                  padding: "12px 16px",
                  borderRadius: "8px",
                  border: `2px solid ${opt.color}`,
                  backgroundColor: "transparent",
                  color: opt.color,
                  cursor: "pointer",
                  fontWeight: "bold",
                  fontSize: "1rem",
                  textAlign: "left",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {step === "COMMITTING" && (
          <div style={{ padding: "16px 0", textAlign: "center", fontStyle: "italic" }}>
            {t("juryArbitration.voteModal.generatingCommit")}
          </div>
        )}

        {step === "COMMITTED" && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{
              backgroundColor: "#313244",
              padding: "12px",
              borderRadius: "8px",
              marginBottom: "12px",
            }}>
              <div style={{ fontSize: "0.85rem", color: "#6c7086" }}>{t("juryArbitration.voteModal.yourVote")}</div>
              <div style={{ fontWeight: "bold", color: "#f9e2af" }}>{selectedVote}</div>
              <div style={{ fontSize: "0.75rem", color: "#585b70", fontFamily: "monospace", marginTop: "4px" }}>
                {t("juryArbitration.voteModal.commitLabel")} {commitHash?.slice(0, 16)}...
              </div>
            </div>
            <p style={{ fontSize: "0.85rem", color: "#6c7086" }}>
              {t("juryArbitration.voteModal.revealPhaseHint")}
            </p>
          </div>
        )}

        {step === "REVEALING" && (
          <div style={{ padding: "16px 0", textAlign: "center" }}>
            <span style={{ display: "inline-block", marginRight: "8px" }}>&#9203;</span>
            {t("juryArbitration.voteModal.revealingOnChain")}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "20px" }}>
          {step === "ERROR" ? (
            <button
              onClick={onClose}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "none",
                backgroundColor: "#f38ba8",
                color: "#11111b",
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              {t("juryArbitration.voteModal.close")}
            </button>
          ) : step === "COMMITTED" ? (
            <button
              onClick={handleReveal}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "none",
                backgroundColor: "#cba6f7",
                color: "#11111b",
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              {t("juryArbitration.voteModal.revealVote")}
            </button>
          ) : step === "REVEALED" ? (
            <button
              onClick={onClose}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "none",
                backgroundColor: "#a6e3a1",
                color: "#11111b",
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              {t("juryArbitration.voteModal.done")}
            </button>
          ) : (
            <button
              onClick={onClose}
              disabled={step === "COMMITTING" || step === "REVEALING"}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "1px solid #45475a",
                backgroundColor: "transparent",
                color: "#cdd6f4",
                cursor: "pointer",
              }}
            >
              {t("juryArbitration.voteModal.cancel")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
