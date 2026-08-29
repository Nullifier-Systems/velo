import { FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "./WebhookSettings.css";

const API_BASE =
  import.meta.env.VITE_API_URL ??
  import.meta.env.VITE_API_BASE_URL ??
  "http://localhost:3000";

export interface WebhookEndpoint {
  endpoint_id: string;
  user_id: string;
  target_url: string;
  secret_key: string;
  is_active: boolean;
  created_at: string;
}

export interface WebhookDeliveryLog {
  delivery_id: string;
  endpoint_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  signature_header: string;
  attempt_count: number;
  status: "QUEUED" | "DELIVERED" | "FAILED" | "DEAD_LETTER";
  last_response_code: number | null;
  created_at: string;
}

export default function WebhookSettings() {
  const { t } = useTranslation();
  const [userId, setUserId] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [filterUserId, setFilterUserId] = useState("");

  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [logs, setLogs] = useState<WebhookDeliveryLog[]>([]);

  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(
    new Set(),
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function loadData(uid?: string): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const epUrl = uid
        ? `${API_BASE}/api/v1/webhooks/endpoints?user_id=${encodeURIComponent(uid)}`
        : `${API_BASE}/api/v1/webhooks/endpoints`;
      const logsUrl = uid
        ? `${API_BASE}/api/v1/webhooks/logs?user_id=${encodeURIComponent(uid)}`
        : `${API_BASE}/api/v1/webhooks/logs`;

      const [epRes, logsRes] = await Promise.all([
        fetch(epUrl),
        fetch(logsUrl),
      ]);

      if (epRes.ok) {
        const epData = await epRes.json();
        setEndpoints(epData.endpoints ?? []);
      }
      if (logsRes.ok) {
        const logsData = await logsRes.json();
        setLogs(logsData.logs ?? []);
      }
    } catch {
      setError(t("common.error"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData(filterUserId.trim() || undefined);
  }, [filterUserId]);

  async function handleRegister(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!userId.trim() || !targetUrl.trim()) return;

    setRegistering(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch(`${API_BASE}/api/v1/webhooks/endpoints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId.trim(),
          target_url: targetUrl.trim(),
          secret_key: secretKey.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t("common.error"));
        return;
      }

      setTargetUrl("");
      setSecretKey("");
      setSuccess(t("common.success"));
      await loadData(filterUserId.trim() || undefined);
    } catch {
      setError(t("common.error"));
    } finally {
      setRegistering(false);
    }
  }

  async function handleReplayDlq(deliveryId?: string): Promise<void> {
    setReplaying(true);
    setError(null);
    setSuccess(null);

    try {
      const body = deliveryId
        ? { delivery_ids: [deliveryId] }
        : { all: true };

      const res = await fetch(`${API_BASE}/api/v1/webhooks/dlq/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t("webhooks.replayError"));
        return;
      }

      setSuccess(t("webhooks.replaySuccess", { count: data.replayed ?? 0 }));
      await loadData(filterUserId.trim() || undefined);
    } catch {
      setError(t("webhooks.replayError"));
    } finally {
      setReplaying(false);
    }
  }

  function toggleRevealSecret(id: string): void {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function copySecret(id: string, secret: string): void {
    void navigator.clipboard.writeText(secret);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  const hasDeadLetterLogs = logs.some((l) => l.status === "DEAD_LETTER");

  return (
    <main className="wh-shell">
      <header className="wh-header">
        <div>
          <h1>{t("webhooks.title")}</h1>
          <p>{t("webhooks.subtitle")}</p>
        </div>
        <button
          className="wh-button wh-button-secondary"
          onClick={() => loadData(filterUserId.trim() || undefined)}
          disabled={loading}
        >
          {t("webhooks.refresh")}
        </button>
      </header>

      {error && (
        <div className="wh-alert wh-alert-error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="wh-alert wh-alert-success" role="status">
          {success}
        </div>
      )}

      {/* Endpoint Registration Card */}
      <section className="wh-card">
        <h2>{t("webhooks.registerHeading")}</h2>
        <form className="wh-form" onSubmit={handleRegister}>
          <div className="wh-form-grid">
            <div className="wh-form-group">
              <label htmlFor="wh-user-id">{t("webhooks.userIdLabel")}</label>
              <input
                id="wh-user-id"
                type="text"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder={t("webhooks.userIdPlaceholder")}
                required
              />
            </div>
            <div className="wh-form-group">
              <label htmlFor="wh-target-url">
                {t("webhooks.targetUrlLabel")}
              </label>
              <input
                id="wh-target-url"
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder={t("webhooks.targetUrlPlaceholder")}
                required
              />
            </div>
          </div>
          <div className="wh-form-group">
            <label htmlFor="wh-secret-key">
              {t("webhooks.secretKeyLabel")}
            </label>
            <input
              id="wh-secret-key"
              type="text"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder={t("webhooks.secretKeyPlaceholder")}
            />
          </div>
          <button
            type="submit"
            className="wh-button"
            disabled={registering || !userId.trim() || !targetUrl.trim()}
          >
            {registering
              ? t("webhooks.registering")
              : t("webhooks.registerButton")}
          </button>
        </form>
      </section>

      {/* Endpoints Table Card */}
      <section className="wh-card">
        <div className="wh-card-header">
          <h2>{t("webhooks.endpointsHeading")}</h2>
          <div className="wh-filter-row">
            <input
              type="text"
              value={filterUserId}
              onChange={(e) => setFilterUserId(e.target.value)}
              placeholder={t("webhooks.filterUserId")}
              style={{
                padding: "0.4rem 0.6rem",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                fontSize: "0.85rem",
              }}
            />
          </div>
        </div>
        <div className="wh-table-wrapper">
          <table className="wh-table">
            <thead>
              <tr>
                <th>{t("webhooks.targetUrlLabel")}</th>
                <th>{t("webhooks.userIdLabel")}</th>
                <th>{t("webhooks.secretKey")}</th>
                <th>{t("webhooks.status")}</th>
                <th>{t("webhooks.createdAt")}</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((ep) => {
                const isRevealed = revealedSecrets.has(ep.endpoint_id);
                return (
                  <tr key={ep.endpoint_id}>
                    <td>
                      <code className="wh-code">{ep.target_url}</code>
                    </td>
                    <td>
                      <span className="wh-code">{ep.user_id}</span>
                    </td>
                    <td>
                      <div className="wh-secret-cell">
                        <code className="wh-code">
                          {isRevealed
                            ? ep.secret_key
                            : "••••••••••••••••••••••••••••••••"}
                        </code>
                        <button
                          type="button"
                          className="wh-button wh-button-secondary wh-button-sm"
                          onClick={() => toggleRevealSecret(ep.endpoint_id)}
                        >
                          {isRevealed
                            ? t("webhooks.hideSecret")
                            : t("webhooks.revealSecret")}
                        </button>
                        <button
                          type="button"
                          className="wh-button wh-button-secondary wh-button-sm"
                          onClick={() =>
                            copySecret(ep.endpoint_id, ep.secret_key)
                          }
                        >
                          {copiedId === ep.endpoint_id
                            ? t("webhooks.copied")
                            : t("webhooks.copySecret")}
                        </button>
                      </div>
                    </td>
                    <td>
                      <span
                        className={`wh-badge ${
                          ep.is_active
                            ? "wh-badge-delivered"
                            : "wh-badge-failed"
                        }`}
                      >
                        {ep.is_active
                          ? t("webhooks.statusActive")
                          : t("webhooks.statusInactive")}
                      </span>
                    </td>
                    <td>
                      {new Date(ep.created_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                  </tr>
                );
              })}
              {endpoints.length === 0 && (
                <tr>
                  <td colSpan={5} className="wh-empty">
                    {t("webhooks.noEndpoints")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Logs Table Card */}
      <section className="wh-card">
        <div className="wh-card-header">
          <h2>{t("webhooks.logsHeading")}</h2>
          {hasDeadLetterLogs && (
            <button
              className="wh-button wh-button-replay wh-button-sm"
              onClick={() => handleReplayDlq()}
              disabled={replaying}
            >
              {replaying
                ? t("webhooks.replaying")
                : t("webhooks.replayDlq")}
            </button>
          )}
        </div>
        <div className="wh-table-wrapper">
          <table className="wh-table">
            <thead>
              <tr>
                <th>{t("webhooks.deliveryId")}</th>
                <th>{t("webhooks.eventType")}</th>
                <th>{t("webhooks.attempts")}</th>
                <th>{t("webhooks.responseCode")}</th>
                <th>{t("webhooks.status")}</th>
                <th>{t("webhooks.createdAt")}</th>
                <th>{t("webhooks.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const statusClass =
                  log.status === "DELIVERED"
                    ? "wh-badge-delivered"
                    : log.status === "QUEUED"
                    ? "wh-badge-queued"
                    : log.status === "DEAD_LETTER"
                    ? "wh-badge-dead-letter"
                    : "wh-badge-failed";

                return (
                  <tr key={log.delivery_id}>
                    <td>
                      <code className="wh-code">
                        {log.delivery_id.slice(0, 8)}…
                      </code>
                    </td>
                    <td>
                      <span className="wh-code">{log.event_type}</span>
                    </td>
                    <td>{log.attempt_count}</td>
                    <td>{log.last_response_code ?? "-"}</td>
                    <td>
                      <span className={`wh-badge ${statusClass}`}>
                        {log.status}
                      </span>
                    </td>
                    <td>
                      {new Date(log.created_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td>
                      {log.status === "DEAD_LETTER" && (
                        <button
                          type="button"
                          className="wh-button wh-button-replay wh-button-sm"
                          onClick={() => handleReplayDlq(log.delivery_id)}
                          disabled={replaying}
                        >
                          {replaying
                            ? t("webhooks.replaying")
                            : t("webhooks.replayDlq")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={7} className="wh-empty">
                    {t("webhooks.noLogs")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
