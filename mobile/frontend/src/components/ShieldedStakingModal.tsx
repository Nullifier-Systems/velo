import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

export interface ShieldedStakingModalProps {
  isOpen: boolean;
  onClose: () => void;
  providerId?: string;
}

type StakingStep = "IDLE" | "GENERATING_PROOF" | "DEPOSITING" | "VERIFYING" | "COMPLETE" | "ERROR";

export function ShieldedStakingModal({
  isOpen,
  onClose,
  providerId = "",
}: ShieldedStakingModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<StakingStep>("IDLE");
  const [stakeAmount, setStakeAmount] = useState("");
  const [commitmentHash, setCommitmentHash] = useState<string | null>(null);
  const [nullifierHash, setNullifierHash] = useState<string | null>(null);
  const [merkleRoot, setMerkleRoot] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!commitmentHash || step !== "VERIFYING") return;

    const interval = setInterval(async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
        const res = await fetch(
          `${apiUrl}/api/v1/provider/shielded-stake/status/${commitmentHash}`,
        );
        if (res.ok) {
          const data = await res.json();
          if (data.isActive) {
            setMerkleRoot(data.merkleRoot);
            setStep("COMPLETE");
          }
        }
      } catch {
        // ignore transient errors
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [commitmentHash, step]);

  if (!isOpen) return null;

  const STROOPS_PER_USDC = 10_000_000;
  const minStakeUsdc = 10;

  const generateCommitment = (): { commitment: string; nullifier: string } => {
    const commitmentBytes = new Uint8Array(32);
    const nullifierBytes = new Uint8Array(32);
    crypto.getRandomValues(commitmentBytes);
    crypto.getRandomValues(nullifierBytes);
    const commitment = Array.from(commitmentBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const nullifier = Array.from(nullifierBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return { commitment, nullifier };
  };

  const handleDepositAndVerify = async () => {
    const amount = parseFloat(stakeAmount);
    if (isNaN(amount) || amount < minStakeUsdc) {
      setErrorMessage(`Minimum stake is ${minStakeUsdc} USDC`);
      setStep("ERROR");
      return;
    }

    setStep("GENERATING_PROOF");
    setErrorMessage(null);

    // Simulate WASM ZK proof generation
    await new Promise((r) => setTimeout(r, 1200));

    const { commitment, nullifier } = generateCommitment();
    setCommitmentHash(commitment);
    setNullifierHash(nullifier);

    setStep("DEPOSITING");

    try {
      const apiUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
      const amountStroops = String(BigInt(Math.floor(amount * STROOPS_PER_USDC)));

      // Step 1: Deposit commitment into shielded pool
      const depositRes = await fetch(`${apiUrl}/api/v1/provider/shielded-stake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commitmentHash: commitment,
          stakedAmountStroops: amountStroops,
        }),
      });

      if (!depositRes.ok) {
        const body = await depositRes.json();
        throw new Error(body.error || "Failed to deposit shielded stake");
      }

      const depositData = await depositRes.json();
      setMerkleRoot(depositData.merkleRoot);

      // Step 2: Submit ZK proof verification
      setStep("VERIFYING");
      const verifyRes = await fetch(`${apiUrl}/api/v1/provider/shielded-stake/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof: "simulated_zk_proof_" + commitment.slice(0, 16),
          merkleRoot: depositData.merkleRoot,
          nullifierHash: nullifier,
          commitmentHash: commitment,
          providerId: providerId || "anonymous_provider",
          minStakeStroops: String(BigInt(minStakeUsdc * STROOPS_PER_USDC)),
        }),
      });

      if (!verifyRes.ok) {
        const body = await verifyRes.json();
        throw new Error(body.message || body.error || "ZK verification failed");
      }

      setStep("COMPLETE");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unknown error");
      setStep("ERROR");
    }
  };

  return (
    <div
      style={{
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
      }}
    >
      <div
        style={{
          backgroundColor: "#1e1e2e",
          color: "#cdd6f4",
          padding: "24px",
          borderRadius: "12px",
          maxWidth: "480px",
          width: "90%",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}
      >
        <h3 style={{ marginTop: 0, color: "#94e2d5" }}>{t("shieldedStaking.title")}</h3>
        <p style={{ fontSize: "0.85rem", color: "#6c7086", marginTop: 0 }}>
          {t("shieldedStaking.description")}
        </p>

        {step === "ERROR" && (
          <div
            style={{
              backgroundColor: "#f38ba8",
              color: "#11111b",
              padding: "12px",
              borderRadius: "6px",
              marginBottom: "16px",
              fontWeight: "bold",
            }}
          >
            {errorMessage}
          </div>
        )}

        {step === "COMPLETE" && (
          <div
            style={{
              backgroundColor: "#a6e3a1",
              color: "#11111b",
              padding: "16px",
              borderRadius: "8px",
              marginBottom: "16px",
            }}
          >
            <div style={{ fontWeight: "bold", marginBottom: "8px" }}>
              {t("shieldedStaking.stakeActive")}
            </div>
            <div style={{ fontSize: "0.8rem", fontFamily: "monospace" }}>
              {t("shieldedStaking.commitment")} {commitmentHash?.slice(0, 16)}...
            </div>
            <div style={{ fontSize: "0.8rem", fontFamily: "monospace" }}>
              {t("shieldedStaking.merkleRoot")} {merkleRoot?.slice(0, 16)}...
            </div>
            <div style={{ fontSize: "0.8rem", marginTop: "8px", color: "#1e1e2e" }}>
              {t("shieldedStaking.verifiedMessage")}
            </div>
          </div>
        )}

        {step === "IDLE" && (
          <div style={{ marginBottom: "16px" }}>
            <label
              style={{
                display: "block",
                marginBottom: "8px",
                fontSize: "0.9rem",
              }}
            >
              {t("shieldedStaking.amountLabel")}
            </label>
            <input
              type="number"
              value={stakeAmount}
              onChange={(e) => setStakeAmount(e.target.value)}
              placeholder={`Minimum ${minStakeUsdc} USDC`}
              min={minStakeUsdc}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "6px",
                border: "1px solid #45475a",
                backgroundColor: "#313244",
                color: "#cdd6f4",
                boxSizing: "border-box",
              }}
            />
            <div style={{ fontSize: "0.75rem", color: "#585b70", marginTop: "4px" }}>
              {t("shieldedStaking.anonymousHint")}
            </div>
          </div>
        )}

        {step === "GENERATING_PROOF" && (
          <div style={{ padding: "16px 0", textAlign: "center", fontStyle: "italic" }}>
            {t("shieldedStaking.generatingProof")}
          </div>
        )}

        {step === "DEPOSITING" && (
          <div style={{ padding: "16px 0", textAlign: "center" }}>
            <span style={{ display: "inline-block", marginRight: "8px" }}>&#9203;</span>
            {t("shieldedStaking.depositing")}
          </div>
        )}

        {step === "VERIFYING" && (
          <div style={{ padding: "16px 0", textAlign: "center" }}>
            <span style={{ display: "inline-block", marginRight: "8px" }}>&#9203;</span>
            {t("shieldedStaking.verifying")}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "12px",
            marginTop: "20px",
          }}
        >
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
              {t("shieldedStaking.close")}
            </button>
          ) : step === "COMPLETE" ? (
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
              {t("shieldedStaking.done")}
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={step !== "IDLE"}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "1px solid #45475a",
                  backgroundColor: "transparent",
                  color: "#cdd6f4",
                  cursor: "pointer",
                }}
              >
                {t("shieldedStaking.cancel")}
              </button>
              {step === "IDLE" && (
                <button
                  onClick={handleDepositAndVerify}
                  style={{
                    padding: "8px 16px",
                    borderRadius: "6px",
                    border: "none",
                    backgroundColor: "#94e2d5",
                    color: "#11111b",
                    cursor: "pointer",
                    fontWeight: "bold",
                  }}
                >
                  {t("shieldedStaking.depositVerify")}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
