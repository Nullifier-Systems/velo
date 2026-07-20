import { useEffect, useState } from 'react';
import { fetchStatus, type StatusResponse } from '../lib/api.js';

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function healthyBadge(status: string): 'status-locked' | 'status-released' | 'status-refunded' {
  if (status === 'ok' || status === 'healthy') return 'status-released';
  if (status === 'unreachable') return 'status-refunded';
  return 'status-locked';
}

export default function Status() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await fetchStatus();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load status');
      }
    }

    load();
    // This is a public transparency page — poll so it stays live for
    // anyone leaving it open (e.g. an investor dashboard tab).
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (error && !data) {
    return (
      <main className="status-container">
        <div className="status-card error-state">Unable to load status: {error}</div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="status-container">
        <div className="status-card loading-state">Loading status…</div>
      </main>
    );
  }

  return (
    <main className="status-container">
      <div className="status-card">
        <h1 className="home-title">Velo Status</h1>
        <p className="home-subtitle">
          Live API and on-chain health, for transparency with users and partners. No trade details,
          balances, or addresses shown here.
        </p>

        <div className="status-grid">
          <div className="status-tile">
            <span className="detail-label">API</span>
            <span className={`status-pill ${healthyBadge(data.api.status)}`}>
              {data.api.status}
            </span>
            <span className="detail-value">up {formatUptime(data.api.uptime_seconds)}</span>
          </div>
          <div className="status-tile">
            <span className="detail-label">Chain ({data.chain.network})</span>
            <span className={`status-pill ${healthyBadge(data.chain.status)}`}>
              {data.chain.status}
            </span>
            <span className="detail-value">
              {data.chain.latest_ledger !== null ? `ledger #${data.chain.latest_ledger}` : 'n/a'}
            </span>
          </div>
        </div>

        <h2 className="status-subheading">Recent activity</h2>
        {data.recent_activity.length === 0 ? (
          <p className="status-empty">No recent trades yet.</p>
        ) : (
          <ul className="activity-list">
            {data.recent_activity.map((item) => (
              <li key={item.id} className="activity-row">
                <span className="detail-value activity-id">{item.id.slice(0, 10)}…</span>
                <span className={`status-pill status-pill-sm status-${item.status}`}>
                  {item.status}
                </span>
                <span className="detail-label">{new Date(item.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="instructions">
          Auto-refreshes every 30s · last updated{' '}
          {new Date(data.api.timestamp).toLocaleTimeString()}
        </p>
      </div>
    </main>
  );
}
