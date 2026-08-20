import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

export interface ZkSettlementModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialNullifierHash?: string;
  initialCommitment?: string;
}

export type ModalStep = "IDLE" | "GENERATING" | "SETTLING" | "SETTLED" | "ERROR";

export function ZkSettlementModal({
  isOpen,
  onClose,
  initialNullifierHash = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  initialCommitment = "f9e8d7c6b5a4039281706f5e4d3c2b1a0f9e8d7c6b5a4039281706f5e4d3c2b1",
}: ZkSettlementModalProps) {
  const { t } = useTranslation();
  const [secretKey, setSecretKey] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);
  const [step, setStep] = useState<ModalStep>("IDLE");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    if (step === "SETTLING" && initialNullifierHash) {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/v1/cash/zk-settle/status/${initialNullifierHash}`);
          if (res.ok) {
            const data = await res.json();
            if (data.status === "SETTLED") {
              setTxHash(data.txHash || "0x1234567890abcdef");
              setStep("SETTLED");
            } else if (data.status === "REJECTED") {
              setErrorMessage(t("zkSettle.nullifierSpent"));
              setStep("ERROR");
            }
          }
        } catch {
          // ignore transient poll errors
        }
      }, 2000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [step, initialNullifierHash, t]);

  if (!isOpen) return null;

  const handleBlurSecret = () => {
    if (!secretKey) {
      setSecretError(null);
      return;
    }
    const isValidHex = /^[0-9a-fA-F]{64}$/.test(secretKey.trim());
    if (!isValidHex) {
      setSecretError(t("zkSettle.invalidHexKey"));
    } else {
      setSecretError(null);
    }
  };

  const handleGenerateAndSettle = async () => {
    if (secretError || (secretKey && !/^[0-9a-fA-F]{64}$/.test(secretKey.trim()))) {
      setSecretError(t("zkSettle.invalidHexKey"));
      return;
    }

    setStep("GENERATING");
    setErrorMessage(null);

    // Simulate WASM proof generation inside Web Worker
    setTimeout(async () => {
      setStep("SETTLING");
      try {
        const res = await fetch("/api/v1/cash/zk-settle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proof: "simulated_zk_proof_data_bytes_hex_998877665544332211",
            nullifierHash: initialNullifierHash,
            commitment: initialCommitment,
            credentialSecret: secretKey || undefined,
          }),
        });

        if (res.status === 409) {
          setErrorMessage(t("zkSettle.nullifierSpent"));
          setStep("ERROR");
        } else if (!res.ok) {
          setErrorMessage(t("zkSettle.failedSubmit"));
          setStep("ERROR");
        }
      } catch (err) {
        setErrorMessage(t("zkSettle.networkError"));
        setStep("ERROR");
      }
    }, 1500);
  };

  return (
    <div className="zk-modal-overlay" style={{
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
      <div className="zk-modal-content" style={{
        backgroundColor: "#1e1e2e",
        color: "#cdd6f4",
        padding: "24px",
        borderRadius: "12px",
        maxWidth: "480px",
        width: "90%",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      }}>
        <h3 style={{ marginTop: 0, color: "#cba6f7" }}>{t("zkSettle.modalTitle")}</h3>

        {step === "ERROR" && (
          <div className="error-banner" style={{
            backgroundColor: "#f38ba8",
            color: "#11111b",
            padding: "12px",
            borderRadius: "6px",
            marginBottom: "16px",
            fontWeight: "bold",
          }}>
            {errorMessage || t("zkSettle.nullifierSpent")}
          </div>
        )}

        {step === "SETTLED" && (
          <div className="settled-badge" style={{
            backgroundColor: "#a6e3a1",
            color: "#11111b",
            padding: "12px",
            borderRadius: "6px",
            marginBottom: "16px",
            textAlign: "center",
            fontWeight: "bold",
          }}>
            {t("zkSettle.settledBadge")}
            {txHash && (
              <div style={{ marginTop: "6px" }}>
                <a
                  href={`https://stellar.expert/explorer/public/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#1e1e2e", textDecoration: "underline" }}
                >
                  {t("zkSettle.viewStellarExpert")}
                </a>
              </div>
            )}
          </div>
        )}

        {step === "IDLE" && (
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", marginBottom: "8px", fontSize: "0.9rem" }}>
              {t("zkSettle.secretLabel")}
            </label>
            <input
              type="text"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              onBlur={handleBlurSecret}
              placeholder={t("zkSettle.secretPlaceholder")}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "6px",
                border: secretError ? "1px solid #f38ba8" : "1px solid #45475a",
                backgroundColor: "#313244",
                color: "#cdd6f4",
                boxSizing: "border-box",
              }}
            />
            {secretError && (
              <span className="error-text" style={{ color: "#f38ba8", fontSize: "0.8rem", marginTop: "4px", display: "block" }}>
                {secretError}
              </span>
            )}
          </div>
        )}

        {step === "GENERATING" && (
          <div style={{ padding: "16px 0", textAlign: "center", fontStyle: "italic" }}>
            {t("zkSettle.generatingProof")}
          </div>
        )}

        {step === "SETTLING" && (
          <div style={{ padding: "16px 0", textAlign: "center" }}>
            <span className="spinner" style={{ display: "inline-block", marginRight: "8px" }}>⏳</span>
            {t("zkSettle.settlingOnStellar")}
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
              {t("zkSettle.closeModal")}
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={step === "GENERATING" || step === "SETTLING"}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "1px solid #45475a",
                  backgroundColor: "transparent",
                  color: "#cdd6f4",
                  cursor: "pointer",
                }}
              >
                {t("zkSettle.cancel")}
              </button>
              {step === "IDLE" && (
                <button
                  onClick={handleGenerateAndSettle}
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
                  {t("zkSettle.generateAndSettle")}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
