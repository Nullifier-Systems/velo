// Issue #433 — Multi-Sig Escrow Threshold Release & Key Recovery Protocol.
//
// This modal never asks for a raw secret key: `signature` is produced
// elsewhere (a wallet / signing device) over the exact payload the API
// reports for this trade, the same non-custodial split used by
// SessionKeyRotationModal. The modal's job is to show the signer what
// they're approving (recipient, amount, quorum), submit the approval, and
// track live progress — "1 of 2 Signatures Collected" — until the
// threshold is met and the escrow releases on-chain.
import { CSSProperties, FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const apiBase = import.meta.env.VITE_API_URL ?? "";

const STELLAR_PUBLIC_KEY = /^G[1-9A-HJ-NP-Za-km-z]{55}$/;
const HEX_SIGNATURE = /^[0-9a-fA-F]{128}$/;

export function isValidSignerAddress(value: string): boolean {
  return STELLAR_PUBLIC_KEY.test(value.trim());
}

export function isValidSignatureHex(value: string): boolean {
  return HEX_SIGNATURE.test(value.trim());
}

export interface MultisigReleaseStatus {
  trade_id: string;
  recipient_address: string;
  release_amount_stroops: string;
  nonce: string;
  threshold: number;
  registered_signers: number;
  status: "pending" | "releasing" | "released" | "failed";
  release_tx_hash: string | null;
  approvals_collected: number;
  approved_by: string[];
}

export interface MultisigApproveResult {
  released: boolean;
  trade_id: string;
  tx_hash?: string;
  approvals_collected: number;
  threshold: number;
  approved_by: string[];
}

export type FetchStatus = (tradeId: string) => Promise<MultisigReleaseStatus>;
export type SubmitApproval = (input: {
  tradeId: string;
  signerAddress: string;
  signature: string;
}) => Promise<MultisigApproveResult>;

async function fetchStatus(tradeId: string): Promise<MultisigReleaseStatus> {
  const response = await fetch(`${apiBase}/api/v1/cash/multisig-release/${tradeId}`);
  if (!response.ok) throw new Error(`failed to load release status (${response.status})`);
  return response.json();
}

async function postApproval(input: {
  tradeId: string;
  signerAddress: string;
  signature: string;
}): Promise<MultisigApproveResult> {
  const response = await fetch(`${apiBase}/api/v1/cash/multisig-release/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trade_id: input.tradeId,
      signer_address: input.signerAddress,
      signature: input.signature,
    }),
  });
  if (!response.ok) throw new Error(`approval failed (${response.status})`);
  return response.json();
}

type Phase = "loading" | "ready" | "submitting" | "awaiting_signatures" | "released" | "error";

const styles: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.45)",
    zIndex: 1000,
  },
  card: {
    background: "var(--bg-sage, #fff)",
    color: "var(--ink-black, #1B2A22)",
    border: "1px solid var(--perforation, #C7D0BE)",
    borderRadius: "12px",
    padding: "20px",
    width: "min(420px, 92vw)",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  form: { display: "flex", flexDirection: "column", gap: "6px" },
  error: { color: "var(--status-refunded, #8F2A1B)" },
  released: { color: "var(--status-released, #1F6B4A)" },
  row: { display: "flex", gap: "8px", alignItems: "center" },
  detail: { display: "flex", justifyContent: "space-between", fontSize: "0.9em" },
};

export default function MultisigApprovalModal({
  open,
  onClose,
  tradeId,
  signerAddress = "",
  signature = "",
  onFetchStatus = fetchStatus,
  onSubmit = postApproval,
}: {
  open: boolean;
  onClose: () => void;
  tradeId: string;
  signerAddress?: string;
  signature?: string;
  onFetchStatus?: FetchStatus;
  onSubmit?: SubmitApproval;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<MultisigReleaseStatus | null>(null);
  const [addressInput, setAddressInput] = useState(signerAddress);
  const [signatureInput, setSignatureInput] = useState(signature);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setPhase("loading");
    onFetchStatus(tradeId)
      .then((result) => {
        setStatus(result);
        setPhase(result.status === "released" ? "released" : "ready");
        setTxHash(result.release_tx_hash ?? undefined);
      })
      .catch(() => setPhase("error"));
  }, [open, tradeId, onFetchStatus]);

  if (!open) return null;

  async function submit(): Promise<void> {
    setPhase("submitting");
    try {
      const result = await onSubmit({
        tradeId,
        signerAddress: addressInput.trim(),
        signature: signatureInput.trim(),
      });
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              approvals_collected: result.approvals_collected,
              approved_by: result.approved_by,
              status: result.released ? "released" : "pending",
            }
          : prev,
      );
      setTxHash(result.tx_hash);
      setPhase(result.released ? "released" : "awaiting_signatures");
    } catch {
      setPhase("error");
    }
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const addressValid = isValidSignerAddress(addressInput);
    const signatureValid = isValidSignatureHex(signatureInput);
    setAddressError(addressValid ? null : t("multisigApproval.invalidAddress"));
    setSignatureError(signatureValid ? null : t("multisigApproval.invalidSignature"));
    if (!addressValid || !signatureValid) return;
    void submit();
  }

  const showForm = phase === "ready" || phase === "submitting" || phase === "error";

  return (
    <div
      className="multisig-approval-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("multisigApproval.dialogLabel")}
      style={styles.overlay}
    >
      <div className="multisig-approval-card" style={styles.card}>
        <h2>{t("multisigApproval.title")}</h2>

        {phase === "loading" && <p role="status">…</p>}

        {status && showForm && (
          <>
            <p>
              {t("multisigApproval.subtitle", {
                threshold: status.threshold,
                signers: status.registered_signers,
              })}
            </p>
            <div style={styles.detail}>
              <span>{t("multisigApproval.recipientLabel")}</span>
              <span>{status.recipient_address}</span>
            </div>
            <div style={styles.detail}>
              <span>{t("multisigApproval.amountLabel")}</span>
              <span>{status.release_amount_stroops}</span>
            </div>
            <div
              className="multisig-approval-progress"
              role="progressbar"
              aria-label={t("multisigApproval.progressLabel")}
              aria-valuemin={0}
              aria-valuemax={status.threshold}
              aria-valuenow={status.approvals_collected}
            >
              {t("multisigApproval.progress", {
                collected: status.approvals_collected,
                required: status.threshold,
              })}
            </div>

            <form className="multisig-approval-form" onSubmit={handleSubmit} style={styles.form}>
              <label htmlFor="multisig-signer-address">
                {t("multisigApproval.signerAddressLabel")}
              </label>
              <input
                id="multisig-signer-address"
                value={addressInput}
                onChange={(event) => setAddressInput(event.target.value)}
                disabled={phase === "submitting"}
              />
              {addressError && (
                <p role="alert" style={styles.error}>
                  {addressError}
                </p>
              )}

              <label htmlFor="multisig-signature">{t("multisigApproval.signatureLabel")}</label>
              <input
                id="multisig-signature"
                value={signatureInput}
                onChange={(event) => setSignatureInput(event.target.value)}
                disabled={phase === "submitting"}
              />
              {signatureError && (
                <p role="alert" style={styles.error}>
                  {signatureError}
                </p>
              )}

              <div style={styles.row}>
                <button type="button" onClick={onClose} disabled={phase === "submitting"}>
                  {t("common.cancel")}
                </button>
                <button type="submit" disabled={phase === "submitting"}>
                  {phase === "submitting"
                    ? t("multisigApproval.submitting")
                    : t("multisigApproval.approve")}
                </button>
              </div>
            </form>

            {phase === "error" && (
              <div role="alert" style={styles.error}>
                <p>{t("multisigApproval.failed")}</p>
              </div>
            )}
          </>
        )}

        {phase === "error" && !status && (
          <div role="alert" style={styles.error}>
            <p>{t("multisigApproval.loadError")}</p>
            <button type="button" onClick={onClose}>
              {t("common.close")}
            </button>
          </div>
        )}

        {phase === "awaiting_signatures" && status && (
          <>
            <div
              className="multisig-approval-progress"
              role="progressbar"
              aria-label={t("multisigApproval.progressLabel")}
              aria-valuemin={0}
              aria-valuemax={status.threshold}
              aria-valuenow={status.approvals_collected}
            >
              {t("multisigApproval.progress", {
                collected: status.approvals_collected,
                required: status.threshold,
              })}
            </div>
            <button type="button" onClick={onClose}>
              {t("common.close")}
            </button>
          </>
        )}

        {phase === "released" && (
          <>
            <p style={{ ...styles.row, ...styles.released }}>
              <span aria-hidden="true">✓</span>
              <span>{t("multisigApproval.released")}</span>
            </p>
            {txHash && (
              <p style={styles.detail}>
                <span>{t("multisigApproval.viewTx")}</span>
                <span>{txHash}</span>
              </p>
            )}
            <button type="button" onClick={onClose}>
              {t("common.close")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
