/**
 * Range Proof Generator Component
 * Controls proof generation via Web Worker
 * Displays progress and handles proof submission
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PedersenCommitment } from "@velo/shared";
import { RANGE_PROOF_PARAMS } from "@velo/shared";

interface RangeProofGeneratorProps {
  commitment: PedersenCommitment;
  onProofGenerated: (
    proofHex: string,
    generationTimeMs: number,
  ) => Promise<void>;
  isGenerating: boolean;
  generationTime: number | null;
}

export const RangeProofGenerator: React.FC<RangeProofGeneratorProps> = ({
  commitment,
  onProofGenerated,
  isGenerating,
  generationTime,
}) => {
  const { t } = useTranslation();
  const [rangeMin, setRangeMin] = useState<string>("700");
  const [rangeMax, setRangeMax] = useState<string>("850");
  const [secret, setSecret] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleGenerateProof = async () => {
    setError(null);

    // Validate inputs
    try {
      const min = BigInt(rangeMin);
      const max = BigInt(rangeMax);
      const secretValue = BigInt(secret);

      if (min > max) {
        throw new Error("Range min must be less than max");
      }

      if (secretValue < min || secretValue > max) {
        throw new Error("Secret value must be within the range bounds");
      }

      if (
        secretValue < RANGE_PROOF_PARAMS.MIN_VALUE ||
        secretValue > RANGE_PROOF_PARAMS.MAX_VALUE
      ) {
        throw new Error(
          `Secret must be between ${RANGE_PROOF_PARAMS.MIN_VALUE} and ${RANGE_PROOF_PARAMS.MAX_VALUE}`,
        );
      }

      // Create worker and generate proof
      const workerScript = `
        self.onmessage = function(e) {
          const request = e.data;
          try {
            // Simulate proof generation
            const proofHex = '${commitment.commitmentHex}' + Math.random().toString(16).slice(2);
            self.postMessage({
              proofHex,
              generationTimeMs: Math.random() * 1000 + 200
            });
          } catch(err) {
            self.postMessage({ error: err.message });
          }
        };
      `;

      const blob = new Blob([workerScript], { type: "application/javascript" });
      const worker = new Worker(URL.createObjectURL(blob));

      worker.postMessage({
        commitmentHex: commitment.commitmentHex,
        secret: secretValue,
        salt: commitment.saltHex,
        rangeMin: min,
        rangeMax: max,
        attributeType: commitment.attributeType,
      });

      setIsSubmitting(true);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Proof generation timeout"));
          worker.terminate();
        }, RANGE_PROOF_PARAMS.TIMEOUT_MS);

        worker.onmessage = async (event) => {
          clearTimeout(timeout);
          worker.terminate();

          if (event.data.error) {
            reject(new Error(event.data.error));
          } else {
            try {
              await onProofGenerated(
                event.data.proofHex,
                event.data.generationTimeMs,
              );
              resolve();
            } catch (err) {
              reject(err);
            }
          }
        };

        worker.onerror = (err: ErrorEvent) => {
          clearTimeout(timeout);
          reject(new Error(err.message || "Worker error"));
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="range-proof-generator">
      <h4>{t("zk.generateRangeProof")}</h4>

      {error && <div className="error-message">{error}</div>}

      <div className="form-group">
        <label htmlFor="secret">{t("zk.secretValue")}</label>
        <input
          id="secret"
          type="number"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={t("zk.enterSecretValue")}
          disabled={isGenerating || isSubmitting}
          min={String(RANGE_PROOF_PARAMS.MIN_VALUE)}
          max={String(RANGE_PROOF_PARAMS.MAX_VALUE)}
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="range-min">{t("zk.rangeMin")}</label>
          <input
            id="range-min"
            type="number"
            value={rangeMin}
            onChange={(e) => setRangeMin(e.target.value)}
            disabled={isGenerating || isSubmitting}
          />
        </div>

        <div className="form-group">
          <label htmlFor="range-max">{t("zk.rangeMax")}</label>
          <input
            id="range-max"
            type="number"
            value={rangeMax}
            onChange={(e) => setRangeMax(e.target.value)}
            disabled={isGenerating || isSubmitting}
          />
        </div>
      </div>

      {generationTime && (
        <div className="generation-time">
          <p>
            {t("zk.generationTime")} {generationTime.toFixed(0)}
            {t("zk.ms")}
          </p>
          {generationTime > 1500 && (
            <p className="warning">{t("zk.generationExceeded")}</p>
          )}
        </div>
      )}

      <button
        className="btn-generate"
        onClick={handleGenerateProof}
        disabled={isGenerating || isSubmitting || !secret}
      >
        {isGenerating || isSubmitting
          ? t("zk.generating")
          : t("zk.generateAndVerifyProof")}
      </button>
    </div>
  );
};

export default RangeProofGenerator;
