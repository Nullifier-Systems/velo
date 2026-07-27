import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import QrScanner from "qr-scanner";
import LanguageSwitcher from "../components/LanguageSwitcher.js";
import {
  fetchCashRequest,
  isUncertainReleaseError,
  reconcileAndRetryRelease,
  releaseCashRequest,
  formatStroops,
  shortAddress,
  type CashRequestStatus,
} from "../lib/api";
import "./MerchantScan.css";

export default function MerchantScan() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [releaseUncertain, setReleaseUncertain] = useState(false);
  const [scannedData, setScannedData] = useState<{ id: string; secret: string } | null>(null);
  const [claimDetails, setClaimDetails] = useState<CashRequestStatus | null>(null);
  const [manualCode, setManualCode] = useState("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<any | null>(null);
  const releaseInFlightRef = useRef(false);

  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("velo-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(theme);
  }, [theme]);

  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    localStorage.setItem("velo-theme", nextTheme);
  };

  const processDecodedText = (decodedText: string) => {
    try {
      let urlObj: URL;
      if (decodedText.startsWith("velo://")) {
        urlObj = new URL(decodedText.replace("velo://", "https://"));
      } else if (decodedText.startsWith("http://") || decodedText.startsWith("https://")) {
        urlObj = new URL(decodedText);
      } else {
        throw new Error(t("merchant.invalidQR"));
      }

      let requestId = urlObj.searchParams.get("request_id");
      if (!requestId) {
        const pathParts = urlObj.pathname.split("/");
        requestId = pathParts[pathParts.length - 1];
      }

      const secret = urlObj.searchParams.get("secret");

      if (!requestId || !secret) {
        throw new Error(t("merchant.missingIdOrSecret"));
      }

      if (scannerRef.current) {
        scannerRef.current.destroy();
        scannerRef.current = null;
      }
      setScanning(false);
      setScannedData({ id: requestId, secret });
      fetchDetails(requestId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("merchant.parseError"));
    }
  };

  useEffect(() => {
    if (scanning && !scannedData && videoRef.current) {
      const qrScanner = new QrScanner(
        videoRef.current,
        (result: any) => {
          processDecodedText(result.data);
        },
        {
          preferredCamera: "environment",
          maxScansPerSecond: 8,
          highlightScanRegion: false,
          calculateScanRegion: (video: any) => {
            const minDim = Math.min(video.videoWidth, video.videoHeight);
            const size = Math.round(minDim * 0.7);
            return {
              x: Math.round((video.videoWidth - size) / 2),
              y: Math.round((video.videoHeight - size) / 2),
              width: size,
              height: size,
              downScaledWidth: 400,
              downScaledHeight: 400,
            };
          },
        }
      );
      scannerRef.current = qrScanner;

      qrScanner.start().catch((err: unknown) => {
        setError(`${t("merchant.cameraError")}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    return () => {
      if (scannerRef.current) {
        scannerRef.current.destroy();
        scannerRef.current = null;
      }
    };
  }, [scanning, scannedData, t]);

  const fetchDetails = async (id: string) => {
    setLoadingDetails(true);
    setError(null);
    try {
      const details = await fetchCashRequest(id);
      setClaimDetails(details);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("merchant.fetchError"));
    } finally {
      setLoadingDetails(false);
    }
  };

  const handleRelease = async (reconcileFirst = false) => {
    if (!scannedData || !claimDetails || releaseInFlightRef.current) return;
    releaseInFlightRef.current = true;
    setReleasing(true);
    setError(null);
    setReleaseUncertain(false);
    try {
      if (reconcileFirst) {
        await reconcileAndRetryRelease(scannedData.id, scannedData.secret);
      } else {
        await releaseCashRequest(scannedData.id, scannedData.secret);
      }
      setSuccessMsg(t("merchant.fundsReleased"));
      setClaimDetails((current) =>
        current ? { ...current, status: "released" } : current
      );
    } catch (err) {
      if (isUncertainReleaseError(err)) {
        setReleaseUncertain(true);
      } else {
        setError(err instanceof Error ? err.message : t("merchant.releaseError"));
      }
    } finally {
      releaseInFlightRef.current = false;
      setReleasing(false);
    }
  };

  const resetScanner = () => {
    setScannedData(null);
    setClaimDetails(null);
    setSuccessMsg(null);
    setReleaseUncertain(false);
    setError(null);
    setManualCode("");
    setScanning(true);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
      processDecodedText(result.data);
    } catch (err) {
      setError(t("merchant.noQRFound"));
    }
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    setError(null);
    processDecodedText(manualCode.trim());
  };

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

  return (
    <div className="merchant-scan-page">
      <LanguageSwitcher />
      {renderThemeToggle()}
      <header className="merchant-scan-header">
        <button onClick={() => navigate("/")} className="back-button" aria-label={t("merchant.goHome")}>
          {t("merchant.home")}
        </button>
        <h1>{t("merchant.title")}</h1>
      </header>

      <main className="merchant-scan-content">
        {error && (
          <div className="merchant-scan-alert error">
            <span className="alert-title">{t("common.error")}</span>
            <p>{error}</p>
            {!scanning && (
              <button onClick={resetScanner} className="scan-retry-button">
                {t("merchant.tryAgain")}
              </button>
            )}
          </div>
        )}

        {successMsg && (
          <div className="merchant-scan-alert success">
            <span className="alert-title">{t("merchant.successTitle")}</span>
            <p>{successMsg}</p>
          </div>
        )}

        {releaseUncertain && (
          <div className="merchant-scan-alert uncertain" role="status">
            <span className="alert-title">{t("merchant.uncertainTitle")}</span>
            <p>{t("merchant.uncertainBody")}</p>
            <button
              onClick={() => handleRelease(true)}
              disabled={releasing}
              className="uncertain-retry-button"
            >
              {releasing
                ? t("merchant.checkingRelease")
                : t("merchant.checkAndRetry")}
            </button>
          </div>
        )}

        {scanning && (
          <div className="scanner-container">
            <div className="scanner-viewfinder">
              <video ref={videoRef} className="scanner-video" />
              <div className="scanner-overlay">
                <div className="scanner-border-corner top-left"></div>
                <div className="scanner-border-corner top-right"></div>
                <div className="scanner-border-corner bottom-left"></div>
                <div className="scanner-border-corner bottom-right"></div>
                <div className="scanner-laser-line"></div>
              </div>
            </div>
            <p className="scanner-hint">{t("merchant.alignQR")}</p>

            <div className="scanner-fallback-section">
              <span className="fallback-divider">{t("merchant.or")}</span>
              <div className="fallback-actions">
                <label className="fallback-file-button">
                  {t("merchant.uploadQR")}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleFileUpload}
                    style={{ display: "none" }}
                  />
                </label>
                <form onSubmit={handleManualSubmit} className="manual-entry-group">
                  <input
                    type="text"
                    placeholder={t("merchant.manualPlaceholder")}
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value)}
                    className="manual-entry-input"
                  />
                  <button type="submit" className="manual-entry-button">
                    {t("merchant.submit")}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {loadingDetails && (
          <div className="loading-details-spinner">
            <div className="spinner"></div>
            <p>{t("merchant.fetching")}</p>
          </div>
        )}

        {claimDetails && (
          <div className="claim-details-card">
            <h2>{t("merchant.verifyClaim")}</h2>
            <div className="details-grid">
              <div className="details-row">
                <span className="details-label">{t("common.amount")}</span>
                <span className="details-value amount">{formatStroops(claimDetails.amountStroops)} Velo</span>
              </div>
              <div className="details-row">
                <span className="details-label">{t("merchant.status")}</span>
                <span className={`details-value status-badge status-${claimDetails.status}`}>
                  {claimDetails.status.toUpperCase()}
                </span>
              </div>
              <div className="details-row">
                <span className="details-label">{t("common.buyer")}</span>
                <span className="details-value address" title={claimDetails.buyer}>
                  {shortAddress(claimDetails.buyer)}
                </span>
              </div>
              <div className="details-row">
                <span className="details-label">{t("common.claimId")}</span>
                <span className="details-value address" title={claimDetails.id}>
                  {shortAddress(claimDetails.id)}
                </span>
              </div>
            </div>

            <div className="details-actions">
              {claimDetails.status === "locked" && !successMsg ? (
                <button
                  onClick={() => handleRelease(false)}
                  disabled={releasing}
                  className="release-action-button"
                >
                  {releasing ? t("merchant.releasing") : t("merchant.releaseButton")}
                </button>
              ) : (
                <button onClick={resetScanner} className="scan-next-button">
                  {t("merchant.scanNext")}
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
