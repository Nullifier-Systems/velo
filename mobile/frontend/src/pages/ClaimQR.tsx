import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  fetchCashRequest,
  releaseCashRequest,
  formatStroops,
  shortAddress,
  type CashRequestStatus,
} from '../lib/api';
import './ClaimQR.css';

const POLL_INTERVAL_MS = 4000;

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: 6, verticalAlign: "text-bottom"}}><polyline points="20 6 9 17 4 12"></polyline></svg>
);

const LockIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginBottom: 8}}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
);

function statusLabel(status: CashRequestStatus["status"]): string {
  if (status === "locked") return "Ready to get cash";
  if (status === "released") return "Completed";
  return "Refunded";
}

export default function ClaimQR() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const secret = searchParams.get('secret');

  const [status, setStatus] = useState<CashRequestStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);

  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("velo-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    const saved = localStorage.getItem("velo-theme");
    if (!saved) {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) => {
        setTheme(e.matches ? "dark" : "light");
      };
      mediaQuery.addEventListener("change", handler);
      return () => mediaQuery.removeEventListener("change", handler);
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(theme);
  }, [theme]);

  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    localStorage.setItem("velo-theme", nextTheme);
  };

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const result = await fetchCashRequest(id);
      setStatus(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong');
    }
  }, [id]);

  useEffect(() => {
    load();
    const interval = setInterval(() => {
      setStatus((current) => {
        if (current?.status === 'locked') load();
        return current;
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const renderThemeToggle = () => (
    <button
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
    >
      {theme === "light" ? (
        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
      ) : (
        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="5"></circle>
          <line x1="12" y1="1" x2="12" y2="3"></line>
          <line x1="12" y1="21" x2="12" y2="23"></line>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
          <line x1="1" y1="12" x2="3" y2="12"></line>
          <line x1="21" y1="12" x2="23" y2="12"></line>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
        </svg>
      )}
    </button>
  );

  if (!id) {
    return (
      <div className="claim-page">
        {renderThemeToggle()}
        <p className="claim-page__state claim-page__state--error">
          This link is missing a claim ID.
        </p>
      </div>
    );
  }

  if (error === 'not-found') {
    return (
      <div className="claim-page">
        {renderThemeToggle()}
        <p className="claim-page__state claim-page__state--error">
          We couldn't find this claim. It may have expired or the link may be incorrect.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="claim-page">
        {renderThemeToggle()}
        <p className="claim-page__state claim-page__state--error">
          Couldn't load this claim right now. Check your connection and try again.
        </p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="claim-page" aria-busy="true" aria-live="polite">
        {renderThemeToggle()}
        <div className="claim-ticket claim-ticket--loading" aria-label="Loading your claim">
          <div className="claim-ticket__header">
            <span className="claim-ticket__brand">VELO</span>
            <span className="claim-ticket__stamp claim-ticket__stamp--skeleton" aria-label="Loading status" />
          </div>
          <div className="claim-ticket__qr-window">
            <div className="claim-ticket__qr-box claim-ticket__qr-box--skeleton">
              <span className="claim-ticket__skeleton-qr" aria-label="Loading QR code" />
            </div>
            <div className="claim-ticket__instruction claim-ticket__instruction--skeleton">
              <span className="claim-ticket__skeleton-line claim-ticket__skeleton-line--strong" />
              <span className="claim-ticket__skeleton-line" />
              <span className="claim-ticket__skeleton-line claim-ticket__skeleton-line--short" />
            </div>
          </div>
          <div className="claim-ticket__perforation" />
          <div className="claim-ticket__details">
            {["Amount", "Agent", "Receipt #"].map((label, index) => (
              <div className="claim-ticket__row" key={label}>
                <span className="claim-ticket__label">{label}</span>
                <span className={index === 0 ? 'claim-ticket__skeleton-value claim-ticket__skeleton-value--amount' : 'claim-ticket__skeleton-value'} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const qrPayload = secret
    ? 'velo://claim?request_id=' + status.id + '&secret=' + secret + '&contract=' + status.contractId
    : null;

  return (
    <div className="claim-page">
      {renderThemeToggle()}
      <div className="claim-ticket">
        <div className="claim-ticket__header">
          <span className="claim-ticket__brand">VELO</span>
          <span
            className={`claim-ticket__stamp claim-ticket__stamp--${status.status}`}
            aria-label={`Status: ${statusLabel(status.status)}`}
          >
            {status.status === "locked" && <CheckIcon />}
            {statusLabel(status.status)}
          </span>
        </div>

        <div className="claim-ticket__qr-window">
          {status.status === 'locked' && qrPayload ? (
            <>
              <div className="claim-ticket__qr-box" aria-label="QR Code for agent to scan">
                <QRCodeSVG value={qrPayload} size={200} level="M" />
              </div>
              <p className="claim-ticket__instruction" aria-live="polite" style={{ fontSize: "1.1rem" }}>
                <LockIcon /><br />
                <strong>Show this to the cash agent.</strong>
                <br />
                They'll scan it to hand you your cash.
              </p>
            </>
          ) : status.status === 'released' ? (
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
            <span className="claim-ticket__label">Agent</span>
            <span className="claim-ticket__value">
              {shortAddress(status.seller)}
            </span>
          </div>
          <div className="claim-ticket__row">
            <span className="claim-ticket__label">Receipt #</span>
            <span className="claim-ticket__value">
              {shortAddress(status.id)}
            </span>
          </div>
        </div>

        {status.status === "locked" && (
          <div className="claim-ticket__actions">
            <a
              href={`/chat/${status.id}?participant=${encodeURIComponent(status.buyer)}`}
              className="claim-ticket__chat-link"
              onClick={(e) => {
                e.preventDefault();
                window.open(
                  `/chat/${status.id}?participant=${encodeURIComponent(status.buyer)}`,
                  "chat",
                  "width=460,height=700"
                );
              }}
            >
              Chat with provider
            </a>
          </div>
        )}

        {import.meta.env.DEV && status.status === 'locked' && secret && (
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
                  setError(err instanceof Error ? err.message : 'release failed');
                } finally {
                  setReleasing(false);
                }
              }}
            >
              {releasing ? 'Releasing...' : 'Confirm hand-off (release funds)'}
            </button>
          </details>
        )}
      </div>
    </div>
  );
}
