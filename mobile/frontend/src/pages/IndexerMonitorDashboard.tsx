import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

interface IndexerStatus {
  latestBlockHeader: {
    ledger_sequence: number;
    block_hash: string;
    parent_hash: string;
    created_at: string;
  } | null;
  recentReorgs: Array<{
    id: string;
    detected_at: string;
    fork_ledger: number;
    rollback_depth: number;
    reason: string;
    resolved_at?: string;
  }>;
  rpcHealth: Array<{
    id: string;
    rpc_url: string;
    is_healthy: boolean;
    last_check: string;
    consecutive_failures: number;
    last_failure_reason?: string;
  }>;
  snapshots: {
    count: number;
    latest: {
      ledger_sequence: number;
      block_hash: string;
      created_at: string;
    } | null;
  };
  currentRpcUrl: string;
}

export function IndexerMonitorDashboard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<IndexerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualRollbackLedger, setManualRollbackLedger] = useState("");

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = async () => {
    try {
      const response = await api.get("/indexer/status");
      setStatus(response.data);
      setError(null);
    } catch (err) {
      setError("Failed to fetch indexer status");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleManualRollback = async () => {
    if (!manualRollbackLedger) return;

    try {
      await api.post("/indexer/rollback", {
        targetLedger: parseInt(manualRollbackLedger),
        reason: "Manual rollback from dashboard",
      });
      alert("Rollback initiated successfully");
      setManualRollbackLedger("");
      fetchStatus();
    } catch (err) {
      alert("Failed to initiate rollback");
      console.error(err);
    }
  };

  const handleCreateSnapshot = async () => {
    try {
      await api.post("/indexer/snapshots");
      alert("Snapshot created successfully");
      fetchStatus();
    } catch (err) {
      alert("Failed to create snapshot");
      console.error(err);
    }
  };

  if (loading) {
    return <div className="p-4">{t('indexer.loadingStatus')}</div>;
  }

  if (error) {
    return <div className="p-4 text-red-500">{t('indexer.error')} {error}</div>;
  }

  if (!status) {
    return <div className="p-4">{t('indexer.noStatusAvailable')}</div>;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">{t('indexer.monitorDashboard')}</h1>

      {/* Current Status */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">{t('indexer.currentStatus')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-gray-600">{t('indexer.latestLedger')}</p>
            <p className="text-2xl font-bold">
              {status.latestBlockHeader?.ledger_sequence ?? "N/A"}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">{t('indexer.blockHash')}</p>
            <p className="text-sm font-mono truncate">
              {status.latestBlockHeader?.block_hash ?? "N/A"}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">{t('indexer.currentRpc')}</p>
            <p className="text-sm font-mono truncate">
              {status.currentRpcUrl}
            </p>
          </div>
        </div>
      </div>

      {/* Reorg Alert Banner */}
      {status.recentReorgs.length > 0 && (
        <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg
                className="h-5 w-5 text-yellow-400"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <p className="text-sm text-yellow-700">
                <strong>{t('indexer.recentReorgDetected')}</strong> {status.recentReorgs.length} {t('indexer.reorgsInLastPeriod')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* RPC Health */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">{t('indexer.rpcNodeHealth')}</h2>
        <div className="space-y-3">
          {status.rpcHealth.map((node) => (
            <div
              key={node.id}
              className={`flex items-center justify-between p-3 rounded ${
                node.is_healthy ? "bg-green-50" : "bg-red-50"
              }`}
            >
              <div className="flex-1">
                <p className="text-sm font-mono truncate">{node.rpc_url}</p>
                <p className="text-xs text-gray-600">
                  {node.is_healthy ? t('indexer.healthy') : t('indexer.unhealthy')} •{" "}
                  {node.consecutive_failures} {t('indexer.consecutiveFailures')}
                </p>
                {node.last_failure_reason && (
                  <p className="text-xs text-red-600">{node.last_failure_reason}</p>
                )}
              </div>
              <div
                className={`w-3 h-3 rounded-full ${
                  node.is_healthy ? "bg-green-500" : "bg-red-500"
                }`}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Recent Reorgs */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">{t('indexer.recentReorgEvents')}</h2>
        {status.recentReorgs.length === 0 ? (
          <p className="text-gray-500">{t('indexer.noRecentReorgs')}</p>
        ) : (
          <div className="space-y-3">
            {status.recentReorgs.map((reorg) => (
              <div key={reorg.id} className="border-l-4 border-yellow-400 pl-4">
                <p className="font-medium">{t('indexer.ledger')} {reorg.fork_ledger}</p>
                <p className="text-sm text-gray-600">
                  {t('indexer.rollbackDepth')} {reorg.rollback_depth} {t('indexer.ledgers')}
                </p>
                <p className="text-sm text-gray-600">{reorg.reason}</p>
                <p className="text-xs text-gray-500">
                  {new Date(reorg.detected_at).toLocaleString()}
                  {reorg.resolved_at && (
                    <span className="ml-2 text-green-600">
                      {t('indexer.resolved')} {new Date(reorg.resolved_at).toLocaleString()}
                    </span>
                  )}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Manual Controls */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">{t('indexer.manualControls')}</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('indexer.manualRollback')}
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                value={manualRollbackLedger}
                onChange={(e) => setManualRollbackLedger(e.target.value)}
                placeholder={t('indexer.targetLedgerSequence')}
                className="flex-1 border rounded px-3 py-2"
              />
              <button
                onClick={handleManualRollback}
                className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700"
              >
                {t('indexer.rollback')}
              </button>
            </div>
          </div>
          <div>
            <button
              onClick={handleCreateSnapshot}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
            >
              {t('indexer.createSnapshot')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
