import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "../components/LanguageSwitcher.js";
import { fetchStatus } from "../lib/api.js";

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function healthyBadge(status: string): "status-locked" | "status-released" | "status-refunded" {
  if (status === "ok" || status === "healthy") return "status-released";
  if (status === "unreachable") return "status-refunded";
  return "status-locked";
}

export default function Status() {
  const { t } = useTranslation();
  const [data, setData] = useState<any | null>(null);
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
        if (!cancelled) setError(err instanceof Error ? err.message : t("status.failedToLoad"));
      }
    }

    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [t]);

  if (error && !data) {
    return (
      <main className="status-container">
        <div className="status-card error-state">{t("status.loadError")}: {error}</div>
      </main>
    );
  }

  if (!data || !data.api || !data.chain) {
    return (
      <main className="status-container">
        <div className="status-card loading-state">{t("status.loading")}</div>
      </main>
    );
  }

  return (
    <main className="status-container">
      <LanguageSwitcher />
      <div className="status-card">
        <h1 className="home-title">{t("status.title")}</h1>
        <p className="home-subtitle">{t("status.subtitle")}</p>

        <div className="status-grid">
          <div className="status-tile">
            <span className="detail-label">{t("status.api")}</span>
            <span className={`status-pill ${healthyBadge(data.api.status)}`}>{data.api.status}</span>
            <span className="detail-value">{t("status.up", { time: formatUptime(data.api.uptime_seconds) })}</span>
          </div>
          <div className="status-tile">
            <span className="detail-label">{t("status.chain")} ({data.chain.network})</span>
            <span className={`status-pill ${healthyBadge(data.chain.status)}`}>{data.chain.status}</span>
            <span className="detail-value">
              {data.chain.latest_ledger !== null ? t("status.ledger", { ledger: data.chain.latest_ledger }) : t("status.nA")}
            </span>
          </div>
        </div>

        <h2 className="status-subheading">{t("status.recentActivity")}</h2>
        {!data.recent_activity || data.recent_activity.length === 0 ? (
          <p className="status-empty">{t("status.noRecentTrades")}</p>
        ) : (
          <ul className="activity-list">
            {data.recent_activity.map((item: any) => (
              <li key={item.id} className="activity-row">
                <span className="detail-value activity-id">{item.id.slice(0, 10)}…</span>
                <span className={`status-pill status-pill-sm status-${item.status}`}>{item.status}</span>
                <span className="detail-label">{new Date(item.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="instructions">{t("status.autoRefresh", { time: new Date(data.api.timestamp || Date.now()).toLocaleTimeString() })}</p>
      </div>
    </main>
  );
}
