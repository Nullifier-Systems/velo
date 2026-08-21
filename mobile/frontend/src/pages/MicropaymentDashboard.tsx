/**
 * Micropayment Dashboard
 * Real-time visualization of off-chain state channel streaming.
 */

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStateChannel } from "../hooks/useStateChannel.js";
import "./MicropaymentDashboard.css";

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
  const { t } = useTranslation();
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
        channelCapacityUsed: Number(
          update.partyABalance + update.partyBBalance,
        ),
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
      setError(t("stateChannels.noBalanceData"));
      return;
    }

    try {
      setIsSettling(true);
      await requestSettlement(latestBalance.partyA, latestBalance.partyB);
      setMetrics((prev) => ({
        ...prev,
        isSettlementReady: false,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Settlement failed");
    } finally {
      setIsSettling(false);
    }
  };

  const capacityPercentage =
    (metrics.channelCapacityUsed / Number(metrics.channelCapacityTotal)) * 100;

  return (
    <div className="micropayment-dashboard">
      <div className="header">
        <h1>{t("stateChannels.title")}</h1>
        <div className="connection-status">
          {isConnecting && (
            <span className="status connecting">
              {t("stateChannels.connecting")}
            </span>
          )}
          {isConnected && (
            <span className="status connected">
              {t("stateChannels.connected")}
            </span>
          )}
          {!isConnected && !isConnecting && (
            <span className="status disconnected">
              {t("stateChannels.disconnected")}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <p>{error}</p>
          <button onClick={() => setError(null)}>
            {t("stateChannels.dismiss")}
          </button>
        </div>
      )}

      <div className="metrics-grid">
        <div className="metric-card">
          <h3>{t("stateChannels.throughput")}</h3>
          <div className="metric-value">
            {metrics.transactionsPerSecond.toFixed(1)}{" "}
            {t("stateChannels.txSec")}
          </div>
          <div className="metric-unit">{t("stateChannels.targetTps")}</div>
        </div>

        <div className="metric-card">
          <h3>{t("stateChannels.totalTransactions")}</h3>
          <div className="metric-value">{metrics.totalTransactions}</div>
          <div className="metric-unit">
            {t("stateChannels.offChainCommits")}
          </div>
        </div>

        <div className="metric-card">
          <h3>{t("stateChannels.sequenceNumber")}</h3>
          <div className="metric-value">{Number(sequenceNumber)}</div>
          <div className="metric-unit">
            {t("stateChannels.vectorClockPosition")}
          </div>
        </div>

        <div className="metric-card">
          <h3>{t("stateChannels.channelCapacity")}</h3>
          <div className="capacity-bar">
            <div
              className="capacity-used"
              style={{ width: `${capacityPercentage}%` }}
            />
          </div>
          <div className="metric-unit">
            {(capacityPercentage || 0).toFixed(1)}{" "}
            {t("stateChannels.capacityUsed")}
          </div>
        </div>
      </div>

      <div className="balance-section">
        <h2>{t("stateChannels.currentBalance")}</h2>
        {latestBalance ? (
          <div className="balance-display">
            <div className="balance-item">
              <label>{t("stateChannels.yourBalance")}</label>
              <div className="balance-value">
                {(Number(latestBalance.partyA) / 1e7).toFixed(2)}{" "}
                {t("stateChannels.usdc")}
              </div>
            </div>
            <div className="balance-item">
              <label>{t("stateChannels.counterpartyBalance")}</label>
              <div className="balance-value">
                {(Number(latestBalance.partyB) / 1e7).toFixed(2)}{" "}
                {t("stateChannels.usdc")}
              </div>
            </div>
          </div>
        ) : (
          <p className="placeholder">{t("stateChannels.noBalanceData")}</p>
        )}
      </div>

      <div className="settlement-section">
        <h2>{t("stateChannels.settlement")}</h2>
        <p className="settlement-info">{t("stateChannels.settlementInfo")}</p>
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
          {isSettling
            ? t("stateChannels.settling")
            : t("stateChannels.settleButton")}
        </button>
      </div>
    </div>
  );
}
