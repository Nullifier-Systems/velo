/**
 * Micropayment Dashboard
 * Real-time visualization of off-chain state channel streaming.
 */

import React, { useEffect, useState } from "react";
import { useStateChannel } from "../hooks/useStateChannel.js";

interface DashboardMetrics {
  transactionsPerSecond: number;
  totalTransactions: number;
  channelCapacityUsed: number;
  channelCapacityTotal: bigint;
  isSettlementReady: boolean;
}

interface MicropaymentDashboardProps {
  channelId: string;
  participantAddress: string;
  totalDepositStroops: bigint;
  apiBaseUrl: string;
}

export function MicropaymentDashboard({
  channelId,
  participantAddress,
  totalDepositStroops,
  apiBaseUrl,
}: MicropaymentDashboardProps) {
  const [metrics, setMetrics] = useState<DashboardMetrics>({
    transactionsPerSecond: 0,
    totalTransactions: 0,
    channelCapacityUsed: 0,
    channelCapacityTotal: totalDepositStroops,
    isSettlementReady: false,
  });

  const [error, setError] = useState<string | null>(null);
  const [isSettling, setIsSettling] = useState(false);

  const {
    isConnected,
    isConnecting,
    latestBalance,
    sequenceNumber,
    requestSettlement,
  } = useStateChannel({
    channelId,
    participantAddress,
    apiBaseUrl,
    onStateUpdate: (update) => {
      setMetrics((prev) => ({
        ...prev,
        totalTransactions: prev.totalTransactions + 1,
        channelCapacityUsed: Number(update.partyABalance + update.partyBBalance),
      }));
    },
    onError: (error) => {
      setError(error.message);
    },
  });

  // Calculate transactions per second
  useEffect(() => {
    const interval = setInterval(() => {
      setMetrics((prev) => {
        // In real app, would track over a sliding window
        // For now, show running total
        return prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const handleSettlement = async () => {
    if (!latestBalance) {
      setError("No state to settle");
      return;
    }

    try {
      setIsSettling(true);
      await requestSettlement(
        latestBalance.partyA,
        latestBalance.partyB
      );
      setMetrics((prev) => ({
        ...prev,
        isSettlementReady: false,
      }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Settlement failed"
      );
    } finally {
      setIsSettling(false);
    }
  };

  const capacityPercentage =
    (metrics.channelCapacityUsed / Number(metrics.channelCapacityTotal)) *
    100;

  return (
    <div className="micropayment-dashboard">
      <div className="header">
        <h1>Micropayment Dashboard</h1>
        <div className="connection-status">
          {isConnecting && (
            <span className="status connecting">Connecting...</span>
          )}
          {isConnected && (
            <span className="status connected">Connected</span>
          )}
          {!isConnected && !isConnecting && (
            <span className="status disconnected">Disconnected</span>
          )}
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <p>{error}</p>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="metrics-grid">
        <div className="metric-card">
          <h3>Throughput</h3>
          <div className="metric-value">
            {metrics.transactionsPerSecond.toFixed(1)} tx/s
          </div>
          <div className="metric-unit">Target: 500 tx/s</div>
        </div>

        <div className="metric-card">
          <h3>Total Transactions</h3>
          <div className="metric-value">{metrics.totalTransactions}</div>
          <div className="metric-unit">off-chain commits</div>
        </div>

        <div className="metric-card">
          <h3>Sequence Number</h3>
          <div className="metric-value">{Number(sequenceNumber)}</div>
          <div className="metric-unit">vector clock position</div>
        </div>

        <div className="metric-card">
          <h3>Channel Capacity</h3>
          <div className="capacity-bar">
            <div
              className="capacity-used"
              style={{ width: `${capacityPercentage}%` }}
            />
          </div>
          <div className="metric-unit">
            {(capacityPercentage || 0).toFixed(1)}% used
          </div>
        </div>
      </div>

      <div className="balance-section">
        <h2>Current Balance</h2>
        {latestBalance ? (
          <div className="balance-display">
            <div className="balance-item">
              <label>Your Balance</label>
              <div className="balance-value">
                {(Number(latestBalance.partyA) / 1e7).toFixed(2)} USDC
              </div>
            </div>
            <div className="balance-item">
              <label>Counterparty Balance</label>
              <div className="balance-value">
                {(Number(latestBalance.partyB) / 1e7).toFixed(2)} USDC
              </div>
            </div>
          </div>
        ) : (
          <p className="placeholder">No balance data yet</p>
        )}
      </div>

      <div className="settlement-section">
        <h2>Settlement</h2>
        <p className="settlement-info">
          When ready, settle this channel on-chain with a single transaction.
          Both parties must have signed the final state.
        </p>
        <button
          className="settle-button"
          onClick={handleSettlement}
          disabled={
            !isConnected ||
            isSettling ||
            !latestBalance ||
            !metrics.isSettlementReady
          }
        >
          {isSettling ? "Settling..." : "Close & Settle Channel"}
        </button>
      </div>

      <style>{`
        .micropayment-dashboard {
          padding: 20px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          max-width: 1200px;
          margin: 0 auto;
        }

        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 30px;
        }

        .header h1 {
          margin: 0;
          font-size: 24px;
        }

        .connection-status {
          font-size: 12px;
          padding: 6px 12px;
          border-radius: 4px;
        }

        .status {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 3px;
          font-weight: 500;
        }

        .status.connected {
          background-color: #d4edda;
          color: #155724;
        }

        .status.connecting {
          background-color: #fff3cd;
          color: #856404;
        }

        .status.disconnected {
          background-color: #f8d7da;
          color: #721c24;
        }

        .error-banner {
          background-color: #f8d7da;
          color: #721c24;
          padding: 12px;
          border-radius: 4px;
          margin-bottom: 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .error-banner p {
          margin: 0;
        }

        .error-banner button {
          background: none;
          border: none;
          color: #721c24;
          cursor: pointer;
          font-weight: bold;
        }

        .metrics-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 20px;
          margin-bottom: 40px;
        }

        .metric-card {
          background: #f8f9fa;
          padding: 20px;
          border-radius: 8px;
          border: 1px solid #dee2e6;
        }

        .metric-card h3 {
          margin: 0 0 10px 0;
          font-size: 14px;
          color: #6c757d;
          text-transform: uppercase;
        }

        .metric-value {
          font-size: 28px;
          font-weight: bold;
          color: #212529;
          margin-bottom: 4px;
        }

        .metric-unit {
          font-size: 12px;
          color: #6c757d;
        }

        .capacity-bar {
          width: 100%;
          height: 20px;
          background-color: #e9ecef;
          border-radius: 4px;
          overflow: hidden;
          margin-bottom: 4px;
        }

        .capacity-used {
          height: 100%;
          background: linear-gradient(90deg, #007bff, #0056b3);
          transition: width 0.3s ease;
        }

        .balance-section {
          background: #f8f9fa;
          padding: 20px;
          border-radius: 8px;
          margin-bottom: 20px;
          border: 1px solid #dee2e6;
        }

        .balance-section h2 {
          margin: 0 0 20px 0;
          font-size: 16px;
        }

        .balance-display {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
        }

        .balance-item label {
          display: block;
          font-size: 12px;
          color: #6c757d;
          margin-bottom: 4px;
        }

        .balance-value {
          font-size: 20px;
          font-weight: bold;
          color: #212529;
        }

        .placeholder {
          color: #6c757d;
          font-style: italic;
        }

        .settlement-section {
          background: #f8f9fa;
          padding: 20px;
          border-radius: 8px;
          border: 1px solid #dee2e6;
        }

        .settlement-section h2 {
          margin: 0 0 10px 0;
          font-size: 16px;
        }

        .settlement-info {
          color: #6c757d;
          font-size: 14px;
          margin: 0 0 20px 0;
        }

        .settle-button {
          background-color: #007bff;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 4px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: background-color 0.2s;
        }

        .settle-button:hover:not(:disabled) {
          background-color: #0056b3;
        }

        .settle-button:disabled {
          background-color: #6c757d;
          cursor: not-allowed;
          opacity: 0.6;
        }
      `}</style>
    </div>
  );
}
