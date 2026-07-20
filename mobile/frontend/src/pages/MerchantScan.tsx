import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QrScanner from 'qr-scanner';
import {
  fetchCashRequest,
  releaseCashRequest,
  formatStroops,
  shortAddress,
  type CashRequestStatus,
} from '../lib/api';
import './MerchantScan.css';

export default function MerchantScan() {
  const navigate = useNavigate();
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [scannedData, setScannedData] = useState<{ id: string; secret: string } | null>(null);
  const [claimDetails, setClaimDetails] = useState<CashRequestStatus | null>(null);
  const [manualCode, setManualCode] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('velo-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
  }, [theme]);

  const toggleTheme = () => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(nextTheme);
    localStorage.setItem('velo-theme', nextTheme);
  };

  const processDecodedText = (decodedText: string) => {
    try {
      // Parse the QR payload
      // format: velo://claim?request_id=xxx&secret=yyy or http://.../claim/xxx?secret=yyy
      let urlObj: URL;
      if (decodedText.startsWith('velo://')) {
        urlObj = new URL(decodedText.replace('velo://', 'https://'));
      } else if (decodedText.startsWith('http://') || decodedText.startsWith('https://')) {
        urlObj = new URL(decodedText);
      } else {
        throw new Error('Invalid Velo QR payload format');
      }

      let requestId = urlObj.searchParams.get('request_id');
      if (!requestId) {
        // Try to extract from path (e.g. /claim/:id)
        const pathParts = urlObj.pathname.split('/');
        requestId = pathParts[pathParts.length - 1];
      }

      const secret = urlObj.searchParams.get('secret');

      if (!requestId || !secret) {
        throw new Error('Missing Claim ID or Secret key in QR payload');
      }

      // Stop/destroy scanner on success
      if (scannerRef.current) {
        scannerRef.current.destroy();
        scannerRef.current = null;
      }
      setScanning(false);
      setScannedData({ id: requestId, secret });
      fetchDetails(requestId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse QR code');
    }
  };

  useEffect(() => {
    // Initialize Nimiq qr-scanner
    if (scanning && !scannedData && videoRef.current) {
      const qrScanner = new QrScanner(
        videoRef.current,
        (result) => {
          processDecodedText(result.data);
        },
        {
          preferredCamera: 'environment',
          maxScansPerSecond: 8, // Throttled to conserve CPU & battery on low-end devices
          highlightScanRegion: false, // We use our own custom stylesheet guide box overlay
          calculateScanRegion: (video) => {
            // Restrict scanning area to center 70% viewfinder box
            const minDim = Math.min(video.videoWidth, video.videoHeight);
            const size = Math.round(minDim * 0.7);
            return {
              x: Math.round((video.videoWidth - size) / 2),
              y: Math.round((video.videoHeight - size) / 2),
              width: size,
              height: size,
              downScaledWidth: 400, // Downscale image representation to 400px before decoding
              downScaledHeight: 400,
            };
          },
        },
      );
      scannerRef.current = qrScanner;

      qrScanner.start().catch((err: unknown) => {
        setError(`Camera access error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    return () => {
      if (scannerRef.current) {
        scannerRef.current.destroy();
        scannerRef.current = null;
      }
    };
  }, [scanning, scannedData]);

  const fetchDetails = async (id: string) => {
    setLoadingDetails(true);
    setError(null);
    try {
      const details = await fetchCashRequest(id);
      setClaimDetails(details);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch claim details');
    } finally {
      setLoadingDetails(false);
    }
  };

  const handleRelease = async () => {
    if (!scannedData || !claimDetails) return;
    setReleasing(true);
    setError(null);
    try {
      await releaseCashRequest(scannedData.id, scannedData.secret);
      setSuccessMsg('Funds successfully released!');
      // refresh claim details
      const updatedDetails = await fetchCashRequest(scannedData.id);
      setClaimDetails(updatedDetails);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Release request failed');
    } finally {
      setReleasing(false);
    }
  };

  const resetScanner = () => {
    setScannedData(null);
    setClaimDetails(null);
    setSuccessMsg(null);
    setError(null);
    setManualCode('');
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
      setError('No valid QR code found in the uploaded image.');
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
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
    >
      {theme === 'light' ? (
        <svg
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          viewBox="0 0 24 24"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
      ) : (
        <svg
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          viewBox="0 0 24 24"
        >
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
      {renderThemeToggle()}
      <header className="merchant-scan-header">
        <button onClick={() => navigate('/')} className="back-button" aria-label="Go home">
          &larr; Home
        </button>
        <h1>Merchant Release Terminal</h1>
      </header>

      <main className="merchant-scan-content">
        {error && (
          <div className="merchant-scan-alert error">
            <span className="alert-title">Error</span>
            <p>{error}</p>
            {!scanning && (
              <button onClick={resetScanner} className="scan-retry-button">
                Try Scanning Again
              </button>
            )}
          </div>
        )}

        {successMsg && (
          <div className="merchant-scan-alert success">
            <span className="alert-title">Success</span>
            <p>{successMsg}</p>
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
            <p className="scanner-hint">Align the buyer's claim QR code within the frame to scan</p>

            <div className="scanner-fallback-section">
              <span className="fallback-divider">OR</span>
              <div className="fallback-actions">
                <label className="fallback-file-button">
                  Upload QR Image
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleFileUpload}
                    style={{ display: 'none' }}
                  />
                </label>
                <form onSubmit={handleManualSubmit} className="manual-entry-group">
                  <input
                    type="text"
                    placeholder="Enter claim URL or code..."
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value)}
                    className="manual-entry-input"
                  />
                  <button type="submit" className="manual-entry-button">
                    Submit
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {loadingDetails && (
          <div className="loading-details-spinner">
            <div className="spinner"></div>
            <p>Fetching claim details...</p>
          </div>
        )}

        {claimDetails && (
          <div className="claim-details-card">
            <h2>Verify Claim</h2>
            <div className="details-grid">
              <div className="details-row">
                <span className="details-label">Amount</span>
                <span className="details-value amount">
                  {formatStroops(claimDetails.amountStroops)} Velo
                </span>
              </div>
              <div className="details-row">
                <span className="details-label">Status</span>
                <span className={`details-value status-badge status-${claimDetails.status}`}>
                  {claimDetails.status.toUpperCase()}
                </span>
              </div>
              <div className="details-row">
                <span className="details-label">Buyer</span>
                <span className="details-value address" title={claimDetails.buyer}>
                  {shortAddress(claimDetails.buyer)}
                </span>
              </div>
              <div className="details-row">
                <span className="details-label">Claim ID</span>
                <span className="details-value address" title={claimDetails.id}>
                  {shortAddress(claimDetails.id)}
                </span>
              </div>
            </div>

            <div className="details-actions">
              {claimDetails.status === 'locked' && !successMsg ? (
                <button
                  onClick={handleRelease}
                  disabled={releasing}
                  className="release-action-button"
                >
                  {releasing ? 'Releasing escrow...' : 'Confirm Handoff & Release Funds'}
                </button>
              ) : (
                <button onClick={resetScanner} className="scan-next-button">
                  Scan Next QR
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
