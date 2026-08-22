/**
 * ZK Proof QR Presenter Component
 * Displays verified attestations as QR codes for sharing
 */

import React, { useState, useEffect } from "react";
import type { ZkAttestation } from "@velo/shared";

interface ZkProofQrPresenterProps {
  attestation: ZkAttestation;
}

export const ZkProofQrPresenter: React.FC<ZkProofQrPresenterProps> = ({
  attestation,
}) => {
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    // Generate QR code from attestation
    generateQrCode();
  }, [attestation]);

  const generateQrCode = () => {
    try {
      // In production, use a QR code library like qrcode.react
      // For now, create a simple text representation
      const attestationData = {
        id: attestation.attestationId,
        proof: attestation.proofId,
        issuer: attestation.issuerPublicKey,
        expires: attestation.expiresAt,
      };

      const qrData = JSON.stringify(attestationData);
      const qrCode = `data:image/png;base64,${Buffer.from(qrData).toString("base64")}`;

      setQrCode(qrCode);
    } catch (error) {
      console.error("Failed to generate QR code:", error);
    }
  };

  const handleCopyAttestation = async () => {
    try {
      const attestationJson = JSON.stringify(
        {
          attestationId: attestation.attestationId,
          proofId: attestation.proofId,
          userId: attestation.userId,
          issuerPublicKey: attestation.issuerPublicKey,
          attestationHex: attestation.attestationHex,
          expiresAt: attestation.expiresAt,
        },
        null,
        2,
      );

      await navigator.clipboard.writeText(attestationJson);
      setIsCopied(true);

      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy attestation:", error);
    }
  };

  const handleDownloadAttestation = () => {
    const attestationJson = JSON.stringify(
      {
        attestationId: attestation.attestationId,
        proofId: attestation.proofId,
        userId: attestation.userId,
        issuerPublicKey: attestation.issuerPublicKey,
        attestationHex: attestation.attestationHex,
        expiresAt: attestation.expiresAt,
      },
      null,
      2,
    );

    const element = document.createElement("a");
    element.setAttribute(
      "href",
      `data:text/plain;charset=utf-8,${encodeURIComponent(attestationJson)}`,
    );
    element.setAttribute("download", `attestation-${attestation.attestationId}.json`);
    element.style.display = "none";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const isExpired = new Date(attestation.expiresAt) < new Date();

  return (
    <div className="zk-proof-qr-presenter">
      <div className="qr-display">
        {qrCode ? (
          <div className="qr-container">
            <img src={qrCode} alt="Attestation QR Code" />
            <p className="qr-label">Scan to verify credential</p>
          </div>
        ) : (
          <div className="qr-placeholder">Generating QR code...</div>
        )}
      </div>

      {isExpired && <div className="expiration-warning">This attestation has expired</div>}

      <div className="attestation-actions">
        <button
          className="btn-copy"
          onClick={handleCopyAttestation}
          disabled={isExpired}
        >
          {isCopied ? "Copied!" : "Copy Attestation"}
        </button>

        <button
          className="btn-download"
          onClick={handleDownloadAttestation}
          disabled={isExpired}
        >
          Download
        </button>
      </div>

      <div className="attestation-meta">
        <p>
          <strong>ID:</strong>
          <code>{attestation.attestationId.slice(0, 12)}...</code>
        </p>
        <p>
          <strong>Issuer:</strong>
          <code>{attestation.issuerPublicKey.slice(0, 16)}...</code>
        </p>
        <p>
          <strong>Expires:</strong>
          {new Date(attestation.expiresAt).toLocaleString()}
        </p>
      </div>
    </div>
  );
};

export default ZkProofQrPresenter;
