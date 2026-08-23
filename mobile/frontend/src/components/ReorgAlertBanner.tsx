import { useState, useEffect } from "react";
import { api } from "../lib/api";

interface ReorgEvent {
  id: string;
  detected_at: string;
  fork_ledger: number;
  rollback_depth: number;
  reason: string;
  resolved_at?: string;
}

interface ReorgAlertBannerProps {
  /** Whether to show the banner automatically when reorgs are detected */
  autoShow?: boolean;
  /** Polling interval in milliseconds (default: 10000) */
  pollInterval?: number;
  /** Callback when a reorg is detected */
  onReorgDetected?: (reorg: ReorgEvent) => void;
  /** Callback when user dismisses the banner */
  onDismiss?: () => void;
}

export function ReorgAlertBanner({
  autoShow = true,
  pollInterval = 10000,
  onReorgDetected,
  onDismiss,
}: ReorgAlertBannerProps) {
  const [recentReorgs, setRecentReorgs] = useState<ReorgEvent[]>([]);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!autoShow) return;

    fetchRecentReorgs();
    const interval = setInterval(fetchRecentReorgs, pollInterval);
    return () => clearInterval(interval);
  }, [autoShow, pollInterval]);

  const fetchRecentReorgs = async () => {
    if (loading) return;
    
    try {
      setLoading(true);
      const response = await api.get("/indexer/reorgs?limit=5");
      const reorgs = response.data.reorgs || [];
      
      // Check for new unresolved reorgs
      const unresolvedReorgs = reorgs.filter((r: ReorgEvent) => !r.resolved_at);
      
      if (unresolvedReorgs.length > 0) {
        setRecentReorgs(unresolvedReorgs);
        setVisible(true);
        
        // Trigger callback for the most recent reorg
        if (onReorgDetected) {
          onReorgDetected(unresolvedReorgs[0]);
        }
      } else {
        setRecentReorgs([]);
        setVisible(false);
      }
    } catch (err) {
      console.error("Failed to fetch recent reorgs:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleDismiss = () => {
    setVisible(false);
    if (onDismiss) {
      onDismiss();
    }
  };

  if (!visible || recentReorgs.length === 0) {
    return null;
  }

  const latestReorg = recentReorgs[0];

  return (
    <div className="bg-red-50 border-l-4 border-red-400 p-4 mb-4">
      <div className="flex">
        <div className="flex-shrink-0">
          <svg
            className="h-5 w-5 text-red-400"
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
        <div className="ml-3 flex-1">
          <h3 className="text-sm font-medium text-red-800">
            Blockchain Reorganization Detected
          </h3>
          <div className="mt-2 text-sm text-red-700">
            <p>
              <strong>Fork Ledger:</strong> {latestReorg.fork_ledger}
            </p>
            <p>
              <strong>Rollback Depth:</strong> {latestReorg.rollback_depth} ledgers
            </p>
            <p className="text-xs text-red-600 mt-1">
              {latestReorg.reason}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Detected at {new Date(latestReorg.detected_at).toLocaleString()}
            </p>
          </div>
          {recentReorgs.length > 1 && (
            <p className="text-xs text-gray-500 mt-2">
              +{recentReorgs.length - 1} additional recent reorg event(s)
            </p>
          )}
        </div>
        <div className="ml-4 flex-shrink-0">
          <button
            onClick={handleDismiss}
            className="text-red-400 hover:text-red-600"
            aria-label="Dismiss"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
