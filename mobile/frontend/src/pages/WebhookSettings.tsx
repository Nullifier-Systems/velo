import React, { useCallback, useEffect, useState } from "react";
import "./WebhookSettings.css";

/**
 * Developer portal for the Distributed Multi-Node Webhook Event Delivery
 * Engine (#445): register a target URL to receive signed trade-status
 * events, view the HMAC secret to configure on the receiving side, monitor
 * recent delivery attempts, and manually replay anything that landed in the
 * dead-letter queue after exhausting its retries.
 */

interface WebhookEndpoint {
  endpoint_id: string;
  user_id: string;
  target_url: string;
  secret_key: string;
  is_active: boolean;
  created_at?: string;
}

type DeliveryStatus = "QUEUED" | "DELIVERED" | "FAILED" | "DEAD_LETTER";

interface DeliveryLog {
  delivery_id: string;
  endpoint_id: string;
  event_type: string;
  attempt_count: number;
  status: DeliveryStatus;
  last_response_code: number | null;
  created_at?: string;
}

function apiBase(): string {
  return (
    (import.meta as any).env?.VITE_API_BASE_URL ||
    (import.meta as any).env?.VITE_API_URL ||
    "http://localhost:3000"
  );
}

function statusClass(status: DeliveryStatus): string {
  switch (status) {
    case "DELIVERED":
      return "webhook-status webhook-status--delivered";
    case "DEAD_LETTER":
      return "webhook-status webhook-status--dead-letter";
    case "FAILED":
      return "webhook-status webhook-status--failed";
    default:
      return "webhook-status webhook-status--queued";
  }
}

export default function WebhookSettings() {
  const [userId, setUserId] = useState("");
  const [loggedInAs, setLoggedInAs] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [targetUrl, setTargetUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryLog[]>([]);

  const loadEndpoints = useCallback(async (address: string) => {
    try {
      const res = await fetch(`${apiBase()}/api/v1/webhooks/endpoints?user_id=${encodeURIComponent(address)}`);
      const json = await res.json();
      if (res.ok) setEndpoints(json.endpoints ?? []);
    } catch {
      // Endpoint list is best-effort; leave the previous state on failure.
    }
  }, []);

  const loadDeliveries = useCallback(async (endpointId: string) => {
    try {
      const res = await fetch(`${apiBase()}/api/v1/webhooks/endpoints/${endpointId}/deliveries`);
      const json = await res.json();
      if (res.ok) setDeliveries(json.deliveries ?? []);
    } catch {
      // Delivery log is best-effort; leave the previous state on failure.
    }
  }, []);

  useEffect(() => {
    if (loggedInAs) void loadEndpoints(loggedInAs);
  }, [loggedInAs, loadEndpoints]);

  useEffect(() => {
    if (selectedEndpointId) {
      void loadDeliveries(selectedEndpointId);
      const interval = setInterval(() => void loadDeliveries(selectedEndpointId), 5_000);
      return () => clearInterval(interval);
    }
  }, [selectedEndpointId, loadDeliveries]);

  async function handleLogIn(event: React.FormEvent) {
    event.preventDefault();
    if (!userId.trim()) return;
    setLoggedInAs(userId.trim());
  }

  async function handleRegister(event: React.FormEvent) {
    event.preventDefault();
    if (!loggedInAs) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase()}/api/v1/webhooks/endpoints`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: loggedInAs, target_url: targetUrl }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Failed to register endpoint");
        return;
      }
      setTargetUrl("");
      setNotice(`Endpoint registered. Secret key (save this now): ${json.secret_key}`);
      await loadEndpoints(loggedInAs);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleReplay(deliveryId: string) {
    setError(null);
    try {
      const res = await fetch(`${apiBase()}/api/v1/webhooks/dlq/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delivery_id: deliveryId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Replay failed — delivery may already be queued");
        return;
      }
      setNotice(`Delivery ${deliveryId} re-queued for delivery.`);
      if (selectedEndpointId) await loadDeliveries(selectedEndpointId);
    } catch (err) {
      setError(String(err));
    }
  }

  if (!loggedInAs) {
    return (
      <div className="webhook-settings">
        <h1>Webhook Settings</h1>
        <form onSubmit={handleLogIn} className="webhook-form">
          <label htmlFor="user-id">Your wallet / developer ID</label>
          <input
            id="user-id"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="GABC...XYZ"
          />
          <button type="submit">Continue</button>
        </form>
      </div>
    );
  }

  return (
    <div className="webhook-settings">
      <h1>Webhook Settings</h1>
      <p className="webhook-subtitle">Signed in as {loggedInAs}</p>

      {error && <div className="webhook-alert webhook-alert--error">{error}</div>}
      {notice && <div className="webhook-alert webhook-alert--notice">{notice}</div>}

      <section>
        <h2>Register a new endpoint</h2>
        <form onSubmit={handleRegister} className="webhook-form">
          <label htmlFor="target-url">Target URL (HTTPS in production)</label>
          <input
            id="target-url"
            type="url"
            required
            value={targetUrl}
            onChange={(event) => setTargetUrl(event.target.value)}
            placeholder="https://your-service.example.com/velo-webhook"
          />
          <button type="submit">Register endpoint</button>
        </form>
      </section>

      <section>
        <h2>Your endpoints</h2>
        {endpoints.length === 0 ? (
          <p>No endpoints registered yet.</p>
        ) : (
          <table className="webhook-table">
            <thead>
              <tr>
                <th>Target URL</th>
                <th>Secret key</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={endpoint.endpoint_id}>
                  <td>{endpoint.target_url}</td>
                  <td className="webhook-secret">{endpoint.secret_key}</td>
                  <td>{endpoint.is_active ? "Active" : "Inactive"}</td>
                  <td>
                    <button type="button" onClick={() => setSelectedEndpointId(endpoint.endpoint_id)}>
                      View deliveries
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedEndpointId && (
        <section>
          <h2>Recent deliveries</h2>
          {deliveries.length === 0 ? (
            <p>No deliveries yet for this endpoint.</p>
          ) : (
            <table className="webhook-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Attempts</th>
                  <th>Status</th>
                  <th>Last response</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deliveries.map((log) => (
                  <tr key={log.delivery_id}>
                    <td>{log.event_type}</td>
                    <td>{log.attempt_count}</td>
                    <td>
                      <span className={statusClass(log.status)}>{log.status}</span>
                    </td>
                    <td>{log.last_response_code ?? "—"}</td>
                    <td>
                      {log.status === "DEAD_LETTER" && (
                        <button type="button" onClick={() => handleReplay(log.delivery_id)}>
                          Replay
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
