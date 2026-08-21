// The modal never polls: the second admin approval reaches it through the injected
// submit result (status "ANCHORED", or signatures_collected >= required_signatures).
import { CSSProperties, FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

const apiBase = import.meta.env.VITE_API_URL ?? "";

const STELLAR_PUBLIC_KEY = /^G[1-9A-HJ-NP-Za-km-z]{55}$/;
const REQUIRED_SIGNATURES = 2;

export interface RotationRequest {
  oldSessionPubkey: string;
  newSessionPubkey: string;
  signerPublicKey: string;
  signature: string;
}

export interface RotationResult {
  proposal_id?: string;
  status?: string;
  signatures_collected: number;
  required_signatures?: number;
}

export type RotationSubmit = (request: RotationRequest) => Promise<RotationResult>;

type Phase = "idle" | "submitting" | "awaiting_signatures" | "anchored" | "error";

/** Session keys are 56-char Stellar `G...` strings. */
export function isValidSessionKey(value: string): boolean {
  return STELLAR_PUBLIC_KEY.test(value.trim());
}

async function postRotation(request: RotationRequest): Promise<RotationResult> {
  const response = await fetch(`${apiBase}/api/v1/session/rotate-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`rotation proposal failed (${response.status})`);
  return response.json();
}

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
  anchored: { color: "var(--status-released, #1F6B4A)" },
  row: { display: "flex", gap: "8px", alignItems: "center" },
};

export default function SessionKeyRotationModal({
  open,
  onClose,
  onSubmit = postRotation,
  signerPublicKey = "",
  signature = "",
}: {
  open: boolean;
  onClose: () => void;
  onSubmit?: RotationSubmit;
  signerPublicKey?: string;
  signature?: string;
}) {
  const { t } = useTranslation();
  const [oldKey, setOldKey] = useState("");
  const [newKey, setNewKey] = useState("");
  const [oldKeyError, setOldKeyError] = useState<string | null>(null);
  const [newKeyError, setNewKeyError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [collected, setCollected] = useState(0);
  const [required, setRequired] = useState(REQUIRED_SIGNATURES);

  if (!open) return null;

  function handleBlur(value: string, setError: (message: string | null) => void): void {
    if (!value.trim()) {
      setError(null);
      return;
    }
    setError(isValidSessionKey(value) ? null : t("sessionRotation.invalidKey"));
  }

  async function submit(): Promise<void> {
    setPhase("submitting");
    try {
      const result = await onSubmit({
        oldSessionPubkey: oldKey.trim(),
        newSessionPubkey: newKey.trim(),
        signerPublicKey,
        signature,
      });
      const needed = result.required_signatures ?? REQUIRED_SIGNATURES;
      setCollected(result.signatures_collected);
      setRequired(needed);
      setPhase(
        result.status === "ANCHORED" || result.signatures_collected >= needed
          ? "anchored"
          : "awaiting_signatures"
      );
    } catch {
      setPhase("error");
    }
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const oldValid = isValidSessionKey(oldKey);
    const newValid = isValidSessionKey(newKey);
    setOldKeyError(oldValid ? null : t("sessionRotation.invalidKey"));
    setNewKeyError(newValid ? null : t("sessionRotation.invalidKey"));
    if (!oldValid || !newValid) return;
    void submit();
  }

  const showForm = phase === "idle" || phase === "submitting" || phase === "error";

  return (
    <div
      className="skr-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("sessionRotation.dialogLabel")}
      style={styles.overlay}
    >
      <div className="skr-modal-card" style={styles.card}>
        <h2>{t("sessionRotation.title")}</h2>

        {showForm && (
          <form className="skr-form" onSubmit={handleSubmit} style={styles.form}>
            <label htmlFor="skr-old-key">{t("sessionRotation.oldKeyLabel")}</label>
            <input
              id="skr-old-key"
              value={oldKey}
              onChange={event => setOldKey(event.target.value)}
              onBlur={() => handleBlur(oldKey, setOldKeyError)}
              disabled={phase === "submitting"}
            />
            {oldKeyError && <p className="skr-error" role="alert" style={styles.error}>{oldKeyError}</p>}

            <label htmlFor="skr-new-key">{t("sessionRotation.newKeyLabel")}</label>
            <input
              id="skr-new-key"
              value={newKey}
              onChange={event => setNewKey(event.target.value)}
              onBlur={() => handleBlur(newKey, setNewKeyError)}
              disabled={phase === "submitting"}
            />
            {newKeyError && <p className="skr-error" role="alert" style={styles.error}>{newKeyError}</p>}

            <div style={styles.row}>
              <button type="button" onClick={onClose} disabled={phase === "submitting"}>
                {t("common.cancel")}
              </button>
              <button type="submit" disabled={phase === "submitting"}>
                {t("sessionRotation.propose")}
              </button>
            </div>
          </form>
        )}

        {phase === "submitting" && (
          <p className="skr-status" role="status" style={styles.row}>
            <span className="skr-spinner" aria-hidden="true">⏳</span>
            <span>{t("sessionRotation.submitting")}</span>
          </p>
        )}

        {phase === "awaiting_signatures" && (
          <>
            <div
              className="skr-progress"
              role="progressbar"
              aria-label={t("sessionRotation.progressLabel")}
              aria-valuemin={0}
              aria-valuemax={required}
              aria-valuenow={collected}
            >
              {t("sessionRotation.progress", { collected, required })}
            </div>
            <button type="button" onClick={onClose}>{t("common.close")}</button>
          </>
        )}

        {phase === "anchored" && (
          <>
            <p className="skr-badge" style={{ ...styles.row, ...styles.anchored }}>
              <span aria-hidden="true">✓</span>
              <span>{t("sessionRotation.anchored")}</span>
            </p>
            <button type="button" onClick={onClose}>{t("common.close")}</button>
          </>
        )}

        {phase === "error" && (
          <div className="skr-banner" role="alert" style={styles.error}>
            <p>{t("sessionRotation.failed")}</p>
            <button type="button" onClick={() => void submit()}>{t("sessionRotation.retry")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
