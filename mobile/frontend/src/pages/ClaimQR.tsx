import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  fetchCashRequest,
  releaseCashRequest,
  formatStroops,
  shortAddress,
  type CashRequestStatus,
} from "../lib/api";
import { useLanguage, translations } from "../lib/lang";
import LanguageToggle from "../components/LanguageToggle";
import "./ClaimQR.css";

const POLL_INTERVAL_MS = 4000;

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: 6, verticalAlign: "text-bottom"}}><polyline points="20 6 9 17 4 12"></polyline></svg>
);

const LockIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginBottom: 8}}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
);

function statusLabel(status: CashRequestStatus["status"], lang: "en" | "es"): string {
  if (status === "locked") return translations[lang].statusReady;
  if (status === "released") return translations[lang].statusReleased;
  return translations[lang].statusRefunded;
}

export default function ClaimQR() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const secret = searchParams.get("secret");
  const mockStatus = searchParams.get("mockStatus") as CashRequestStatus["status"] | "loading" | null;

  const [status, setStatus] = useState<CashRequestStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const { lang } = useLanguage();
  const t = translations[lang];

  // Synchronize HTML lang attribute with active UI language for screen readers
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

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

    if (mockStatus) {
      if (mockStatus === "loading") {
        setStatus(null);
        setError(null);
        return;
      }
      setStatus({
        id,
        contractId: "test-contract-id",
        seller: "G1234567890123456789012345678901234567890123456789012345",
        buyer: "G5432109876543210987654321098765432109876543210987654321",
        amountStroops: "150000000", // 15.00 USDC
        secretHashHex: "abcdef",
        status: mockStatus as CashRequestStatus["status"],
        createdAt: new Date().toISOString(),
      });
      setError(null);
      return;
    }

    try {
      const result = await fetchCashRequest(id);
      setStatus(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong');
    }
  }, [id, mockStatus]);

  useEffect(() => {
    load();
    if (mockStatus) return; // Don't poll in mock mode
    // Poll while locked so the screen updates the moment a merchant scans
    // and releases funds — no manual refresh needed at the counter.
    const interval = setInterval(() => {
      setStatus((current) => {
        if (current?.status === 'locked') load();
        return current;
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load, mockStatus]);

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
        <LanguageToggle />
        {renderThemeToggle()}
        <p className="claim-page__state claim-page__state--error">
          {t.missingId}
        </p>
      </div>
    );
  }

  if (error === 'not-found') {
    return (
      <div className="claim-page">
        <LanguageToggle />
        {renderThemeToggle()}
        <p className="claim-page__state claim-page__state--error">
          {t.notFound}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="claim-page">
        <LanguageToggle />
        {renderThemeToggle()}
        <p className="claim-page__state claim-page__state--error">
          {t.loadError}
        </p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="claim-page" aria-busy="true" aria-live="polite">
        <LanguageToggle />
        {renderThemeToggle()}
        <div className="claim-ticket claim-ticket--loading" role="status" aria-label={t.loadingLabel}>
          <div className="claim-ticket__header">
            <span className="claim-ticket__brand" role="heading" aria-level={1}>VELO</span>
            <span className="claim-ticket__stamp claim-ticket__stamp--skeleton" aria-label={t.loadingLabel} />
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
            {[t.amount, t.provider, t.claimId].map((label, index) => (
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
      <LanguageToggle />
      {renderThemeToggle()}
      <div className="claim-ticket">
        <div className="claim-ticket__header">
          <span className="claim-ticket__brand" role="heading" aria-level={1}>VELO</span>
          <span
            className={`claim-ticket__stamp claim-ticket__stamp--${status.status}`}
            aria-label={`Status: ${statusLabel(status.status, lang)}`}
            aria-live="polite"
          >
            {status.status === "locked" && <CheckIcon />}
            {statusLabel(status.status, lang)}
          </span>
        </div>

        <div className="claim-ticket__qr-window">
          {status.status === 'locked' && qrPayload ? (
            <>
              <div className="claim-ticket__qr-box" aria-label={t.qrCodeDescription}>
                <QRCodeSVG
                  value={qrPayload}
                  size={200}
                  level="M"
                  role="img"
                  title={t.qrCodeDescription}
                />
              </div>
              <p className="claim-ticket__instruction" aria-live="polite" style={{ fontSize: "1.1rem" }}>
                <LockIcon /><br />
                <strong role="heading" aria-level={2}>{t.instructionLocked}</strong>
                <br />
                {t.instructionLockedSub}
              </p>
            </>
          ) : status.status === 'released' ? (
            <p className="claim-ticket__instruction">
              <strong role="heading" aria-level={2}>{t.instructionReleased}</strong>
              <br />
              {t.instructionReleasedSub}
            </p>
          ) : (
            <p className="claim-ticket__instruction">
              <strong role="heading" aria-level={2}>{t.instructionRefunded}</strong>
              <br />
              {t.instructionRefundedSub}
            </p>
          )}
        </div>

        <div className="claim-ticket__perforation" />

        <div className="claim-ticket__details">
          <div className="claim-ticket__row">
            <span className="claim-ticket__label">{t.amount}</span>
            <span className="claim-ticket__amount">
              {formatStroops(status.amountStroops)}
            </span>
          </div>
          <div className="claim-ticket__row">
            <span className="claim-ticket__label">{t.provider}</span>
            <span className="claim-ticket__value">
              {shortAddress(status.seller)}
            </span>
          </div>
          <div className="claim-ticket__row">
            <span className="claim-ticket__label">{t.claimId}</span>
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
            <summary>{t.debugTitle}</summary>
            <button
              className="claim-ticket__debug-button"
              disabled={releasing}
              onClick={async () => {
                setReleasing(true);
                try {
                  if (mockStatus) {
                    // Simulate API network delay and status transition
                    await new Promise((resolve) => setTimeout(resolve, 800));
                    setStatus((current) => current ? { ...current, status: "released" } : null);
                  } else {
                    await releaseCashRequest(status.id, secret);
                    await load();
                  }
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'release failed');
                } finally {
                  setReleasing(false);
                }
              }}
            >
              {releasing ? t.debugReleasing : t.debugButton}
            </button>
          </details>
        )}
      </div>
    </div>
  );
}