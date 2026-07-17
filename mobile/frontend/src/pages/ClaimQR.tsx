import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  fetchCashRequest,
  releaseCashRequest,
  formatStroops,
  shortAddress,
  type CashRequestStatus,
} from "../lib/api";
import "./ClaimQR.css";

const POLL_INTERVAL_MS = 4000;

function statusLabel(status: CashRequestStatus["status"]): string {
  if (status === "locked") return "Ready to claim";
  if (status === "released") return "Released";
  return "Refunded";
}

export default function ClaimQR() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const secret = searchParams.get("secret");

  const [status, setStatus] = useState<CashRequestStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const result = await fetchCashRequest(id);
      setStatus(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    }
  }, [id]);

  useEffect(() => {
    load();
    // Poll while locked so the screen updates the moment a merchant scans
    // and releases funds — no manual refresh needed at the counter.
    const interval = setInterval(() => {
      setStatus((current) => {
        if (current?.status === "locked") load();
        return current;
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  if (!id) {
    return (
      <div className="claim-page">
        <p className="claim-page__state claim-page__state--error">
          This link is missing a claim ID.
        </p>
      </div>
    );
  }

  if (error === "not-found") {
    return (
      <div className="claim-page">
        <p className="claim-page__state claim-page__state--error">
          We couldn't find this claim. It may have expired or the link may be
          incorrect.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="claim-page">
        <p className="claim-page__state claim-page__state--error">
          Couldn't load this claim right now. Check your connection and try
          again.
        </p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="claim-page" aria-busy="true" aria-live="polite">
        <div className="claim-ticket claim-ticket--loading" aria-label="Loading your claim">
          <div className="claim-ticket__header">
            <span className="claim-ticket__brand">VELO</span>
            <span className="claim-ticket__stamp claim-ticket__stamp--skeleton" />
          </div>

          <div className="claim-ticket__qr-window">
            <div className="claim-ticket__qr-box claim-ticket__qr-box--skeleton">
              <span className="claim-ticket__skeleton-qr" />
            </div>
            <div className="claim-ticket__instruction claim-ticket__instruction--skeleton">
              <span className="claim-ticket__skeleton-line claim-ticket__skeleton-line--strong" />
              <span className="claim-ticket__skeleton-line" />
              <span className="claim-ticket__skeleton-line claim-ticket__skeleton-line--short" />
            </div>
          </div>

          <div className="claim-ticket__perforation" />

          <div className="claim-ticket__details">
            {["Amount", "Provider", "Claim ID"].map((label, index) => (
              <div className="claim-ticket__row" key={label}>
                <span className="claim-ticket__label">{label}</span>
                <span
                  className={
                    index === 0
                      ? "claim-ticket__skeleton-value claim-ticket__skeleton-value--amount"
                      : "claim-ticket__skeleton-value"
                  }
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const qrPayload = secret
    ? `velo://claim?request_id=${status.id}&secret=${secret}&contract=${status.contractId}`
    : null;

  return (
    <div className="claim-page">
      <div className="claim-ticket">
        <div className="claim-ticket__header">
          <span className="claim-ticket__brand">VELO</span>
          <span
            className={`claim-ticket__stamp claim-ticket__stamp--${status.status}`}
          >
            {statusLabel(status.status)}
          </span>
        </div>

        <div className="claim-ticket__qr-window">
          {status.status === "locked" && qrPayload ? (
            <>
              <div className="claim-ticket__qr-box">
                <QRCodeSVG value={qrPayload} size={200} level="M" />
              </div>
              <p className="claim-ticket__instruction">
                <strong>Show this to the cash provider.</strong>
                <br />
                They'll scan it to hand you your cash.
              </p>
            </>
          ) : status.status === "released" ? (
            <p className="claim-ticket__instruction">
              <strong>This claim has been completed.</strong>
              <br />
              Funds were released to the provider.
            </p>
          ) : (
            <p className="claim-ticket__instruction">
              <strong>This claim was refunded.</strong>
              <br />
              Funds were returned to the sender.
            </p>
          )}
        </div>

        <div className="claim-ticket__perforation" />

        <div className="claim-ticket__details">
          <div className="claim-ticket__row">
            <span className="claim-ticket__label">Amount</span>
            <span className="claim-ticket__amount">
              {formatStroops(status.amountStroops)}
            </span>
          </div>
          <div className="claim-ticket__row">
            <span className="claim-ticket__label">Provider</span>
            <span className="claim-ticket__value">
              {shortAddress(status.seller)}
            </span>
          </div>
          <div className="claim-ticket__row">
            <span className="claim-ticket__label">Claim ID</span>
            <span className="claim-ticket__value">
              {shortAddress(status.id)}
            </span>
          </div>
        </div>

        {status.status === "locked" && secret && (
          <details className="claim-ticket__debug">
            <summary>Testnet: simulate provider scan</summary>
            <button
              className="claim-ticket__debug-button"
              disabled={releasing}
              onClick={async () => {
                setReleasing(true);
                try {
                  await releaseCashRequest(status.id, secret);
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "release failed");
                } finally {
                  setReleasing(false);
                }
              }}
            >
              {releasing ? "Releasing…" : "Confirm hand-off (release funds)"}
            </button>
          </details>
        )}
      </div>
    </div>
  );
}
