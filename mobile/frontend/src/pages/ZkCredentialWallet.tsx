/**
 * ZK Credential Wallet
 * React component for managing Pedersen commitments and generating range proofs
 * Features:
 * - Display user's credentials and verified attestations
 * - Generate range proofs via Web Worker (WASM)
 * - Submit proofs for verification
 * - Display QR codes for credential sharing
 */

import React, { useState, useEffect, useCallback } from "react";
import type {
  PedersenCommitment,
  ZkAttestation,
  WasmRangeProofRequest,
  WasmRangeProofResponse,
  RANGE_PROOF_PARAMS as RangeProofParams,
} from "@velo/shared";
import { RANGE_PROOF_PARAMS } from "@velo/shared";
import RangeProofGenerator from "../components/RangeProofGenerator";
import ZkProofQrPresenter from "../components/ZkProofQrPresenter";
import "./ZkCredentialWallet.css";

interface ZkCredentialWalletProps {
  userId: string; // Stellar address
}

export const ZkCredentialWallet: React.FC<ZkCredentialWalletProps> = ({
  userId,
}) => {
  const [commitments, setCommitments] = useState<PedersenCommitment[]>([]);
  const [attestations, setAttestations] = useState<ZkAttestation[]>([]);
  const [isLoadingCommitments, setIsLoadingCommitments] = useState(true);
  const [isLoadingAttestations, setIsLoadingAttestations] = useState(true);
  const [selectedCommitmentId, setSelectedCommitmentId] = useState<
    string | null
  >(null);
  const [proofGenerationTime, setProofGenerationTime] = useState<number | null>(
    null,
  );
  const [isGeneratingProof, setIsGeneratingProof] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch user's commitments on mount
  useEffect(() => {
    fetchCommitments();
  }, [userId]);

  // Fetch user's attestations on mount
  useEffect(() => {
    fetchAttestations();
  }, [userId]);

  const fetchCommitments = useCallback(async () => {
    try {
      setIsLoadingCommitments(true);
      setError(null);

      const response = await fetch(`/api/v1/zk/commitments/${userId}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch commitments: ${response.statusText}`);
      }

      const data = await response.json();
      setCommitments(data.commitments || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setIsLoadingCommitments(false);
    }
  }, [userId]);

  const fetchAttestations = useCallback(async () => {
    try {
      setIsLoadingAttestations(true);

      const response = await fetch(`/api/v1/zk/attestations/${userId}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch attestations: ${response.statusText}`);
      }

      const data = await response.json();
      setAttestations(data.attestations || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setIsLoadingAttestations(false);
    }
  }, [userId]);

  const handleProofGenerated = useCallback(
    async (proofHex: string, generationTimeMs: number) => {
      setProofGenerationTime(generationTimeMs);
      setIsGeneratingProof(false);

      if (selectedCommitmentId) {
        // Submit proof to backend for verification
        try {
          const response = await fetch("/api/v1/zk/verify-range-proof", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commitmentId: selectedCommitmentId,
              proofHex,
              rangeMin: "700",
              rangeMax: "850",
            }),
          });

          if (!response.ok) {
            throw new Error(`Verification failed: ${response.statusText}`);
          }

          // Refresh attestations
          await fetchAttestations();
          setSelectedCommitmentId(null);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setError(message);
        }
      }
    },
    [selectedCommitmentId, fetchAttestations],
  );

  const handleGenerateProof = useCallback(
    async (
      commitment: PedersenCommitment,
      rangeMin: bigint,
      rangeMax: bigint,
    ) => {
      setIsGeneratingProof(true);
      setError(null);

      try {
        // Create Web Worker for WASM proof generation
        const workerCode = `
          importScripts('zkProofWorker.ts');
        `;
        const blob = new Blob([workerCode], { type: "application/javascript" });
        const workerUrl = URL.createObjectURL(blob);
        const worker = new Worker(workerUrl);

        // Send proof generation request
        const request: WasmRangeProofRequest = {
          commitmentHex: commitment.commitmentHex,
          secret: 750n, // TODO: Get actual secret from user input
          salt: commitment.saltHex,
          rangeMin,
          rangeMax,
          attributeType: commitment.attributeType,
        };

        worker.postMessage(request);

        // Wait for worker response with timeout
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Proof generation timeout")),
            RANGE_PROOF_PARAMS.TIMEOUT_MS + 500,
          ),
        );

        const responsePromise = new Promise<WasmRangeProofResponse>(
          (resolve, reject) => {
            worker.onmessage = (
              event: MessageEvent<WasmRangeProofResponse>,
            ) => {
              if ("error" in event.data) {
                const errorMsg = (event.data as any).error || "Unknown error";
                reject(new Error(errorMsg));
              } else {
                resolve(event.data);
              }
              worker.terminate();
              URL.revokeObjectURL(workerUrl);
            };
            worker.onerror = (err: ErrorEvent) => {
              reject(new Error(err.message || "Worker error"));
              worker.terminate();
              URL.revokeObjectURL(workerUrl);
            };
          },
        );

        const response = await Promise.race([responsePromise, timeoutPromise]);
        handleProofGenerated(response.proofHex, response.generationTimeMs);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Proof generation failed";
        setError(message);
        setIsGeneratingProof(false);
      }
    },
    [handleProofGenerated],
  );

  return (
    <div className="zk-credential-wallet">
      <h1>ZK Credential Wallet</h1>

      {error && <div className="error-message">{error}</div>}

      {/* Commitments Section */}
      <section className="commitments-section">
        <h2>Your Credentials</h2>

        {isLoadingCommitments ? (
          <p>Loading commitments...</p>
        ) : commitments.length === 0 ? (
          <p>No credentials yet. Issue a commitment to get started.</p>
        ) : (
          <div className="commitments-list">
            {commitments.map((commitment) => (
              <div key={commitment.commitmentId} className="commitment-card">
                <div className="commitment-header">
                  <h3>{commitment.attributeType}</h3>
                  <span className="commitment-id">
                    {commitment.commitmentId.slice(0, 8)}...
                  </span>
                </div>

                <div className="commitment-details">
                  <p>
                    <strong>Commitment:</strong>
                    <code>{commitment.commitmentHex.slice(0, 16)}...</code>
                  </p>
                  <p>
                    <strong>Expires:</strong>
                    {new Date(commitment.expiresAt || "").toLocaleDateString()}
                  </p>
                </div>

                {selectedCommitmentId === commitment.commitmentId ? (
                  <RangeProofGenerator
                    commitment={commitment}
                    onProofGenerated={handleProofGenerated}
                    isGenerating={isGeneratingProof}
                    generationTime={proofGenerationTime}
                  />
                ) : (
                  <button
                    className="btn-generate-proof"
                    onClick={() => {
                      setSelectedCommitmentId(commitment.commitmentId);
                      handleGenerateProof(commitment, 700n, 850n);
                    }}
                    disabled={isGeneratingProof}
                  >
                    Generate Range Proof
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Attestations Section */}
      <section className="attestations-section">
        <h2>Verified Attestations</h2>

        {isLoadingAttestations ? (
          <p>Loading attestations...</p>
        ) : attestations.length === 0 ? (
          <p>No verified attestations yet. Generate and verify a proof.</p>
        ) : (
          <div className="attestations-list">
            {attestations.map((attestation) => (
              <div key={attestation.attestationId} className="attestation-card">
                <div className="attestation-header">
                  <h3>Verified</h3>
                  <span className="attestation-id">
                    {attestation.attestationId.slice(0, 8)}...
                  </span>
                </div>

                <div className="attestation-details">
                  <p>
                    <strong>Issuer:</strong>
                    <code>{attestation.issuerPublicKey.slice(0, 16)}...</code>
                  </p>
                  <p>
                    <strong>Expires:</strong>
                    {new Date(attestation.expiresAt).toLocaleDateString()}
                  </p>
                </div>

                <ZkProofQrPresenter attestation={attestation} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default ZkCredentialWallet;
