import { FormEvent, useMemo, useState } from "react";
import "./AdminDashboard.css";

type Severity = "low" | "medium" | "high";
type SortMode = "recency" | "severity";

interface AdminTrade {
  id: string;
  seller_address: string;
  buyer_address: string;
  status: string;
  is_suspicious: boolean;
  suspicion_notes: string | null;
  flagged_at: string | null;
  created_at: string;
}

interface RateLimitViolation {
  id: string;
  identifier: string;
  route: string;
  method: string;
  occurred_at: string;
  offense_count: number;
  severity: Severity;
  status: "open" | "resolved";
  resolved_at: string | null;
  resolved_by: string | null;
}

export type AbuseFeedItem =
  | {
      id: string;
      type: "fraud";
      severity: Severity;
      occurredAt: string;
      trade: AdminTrade;
    }
  | {
      id: string;
      type: "rate-limit";
      severity: Severity;
      occurredAt: string;
      violation: RateLimitViolation;
    };

const severityRank: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
const apiBase = import.meta.env.VITE_API_URL ?? "";

export function mergeAbuseFeed(
  trades: AdminTrade[],
  violations: RateLimitViolation[],
): AbuseFeedItem[] {
  const fraudItems: AbuseFeedItem[] = trades
    .filter(trade => trade.is_suspicious)
    .map(trade => ({
      id: `fraud:${trade.id}`,
      type: "fraud",
      // Fraud flags are explicit operator alerts and have no native severity,
      // so they enter the shared comparison as high severity.
      severity: "high",
      occurredAt: trade.flagged_at ?? trade.created_at,
      trade,
    }));
  const rateLimitItems: AbuseFeedItem[] = violations.map(violation => ({
    id: `rate-limit:${violation.id}`,
    type: "rate-limit",
    severity: violation.severity,
    occurredAt: violation.occurred_at,
    violation,
  }));
  return [...fraudItems, ...rateLimitItems];
}

export function sortAbuseFeed(items: AbuseFeedItem[], mode: SortMode): AbuseFeedItem[] {
  return [...items].sort((a, b) => {
    if (mode === "severity") {
      const severityDifference = severityRank[b.severity] - severityRank[a.severity];
      if (severityDifference !== 0) return severityDifference;
    }
    return Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
  });
}

export default function AdminDashboard() {
  const [keyInput, setKeyInput] = useState("");
  const [adminKey, setAdminKey] = useState<string | null>(null);
  const [operatorName, setOperatorName] = useState("System Admin");
  const [items, setItems] = useState<AbuseFeedItem[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>("recency");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const logout = () => {
    setAdminKey(null);
    setKeyInput("");
    setItems([]);
    setError(null);
  };

  async function request(path: string, key: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        "x-admin-api-key": key,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (response.status === 401) logout();
    return response;
  }

  async function loadFeed(key: string): Promise<void> {
    const [tradesResponse, violationsResponse] = await Promise.all([
      request("/api/v1/admin/trades", key),
      request("/api/v1/admin/rate-limit-violations", key),
    ]);
    if (tradesResponse.status === 401 || violationsResponse.status === 401) return;
    if (!tradesResponse.ok || !violationsResponse.ok) throw new Error("Failed to load abuse feed.");

    const tradesBody = await tradesResponse.json();
    const violationsBody = await violationsResponse.json();
    setItems(mergeAbuseFeed(tradesBody.data ?? [], violationsBody.data ?? []));
  }

  async function authenticate(event: FormEvent): Promise<void> {
    event.preventDefault();
    const submittedKey = keyInput.trim();
    if (!submittedKey) return;
    setLoading(true);
    setError(null);
    try {
      const validation = await request("/api/v1/admin/status", submittedKey);
      if (!validation.ok) {
        if (validation.status !== 401) setError("Admin authentication failed.");
        return;
      }
      setAdminKey(submittedKey);
      await loadFeed(submittedKey);
    } catch {
      setError("Admin dashboard is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  async function actOnItem(item: AbuseFeedItem): Promise<void> {
    if (!adminKey) return;
    setError(null);
    const path = item.type === "fraud"
      ? `/api/v1/admin/trades/${item.trade.id}/flag`
      : `/api/v1/admin/rate-limit-violations/${item.violation.id}/resolve`;
    const response = await request(path, adminKey, {
      method: "POST",
      headers: { "x-admin-operator-name": operatorName },
      body: item.type === "fraud" ? JSON.stringify({ suspicious: false }) : undefined,
    });
    if (response.status === 401) return;
    if (!response.ok) {
      setError("Operator action failed.");
      return;
    }

    if (item.type === "fraud") {
      setItems(current => current.filter(currentItem => currentItem.id !== item.id));
    } else {
      const body = await response.json();
      setItems(current => current.map(currentItem => {
        if (currentItem.id !== item.id || currentItem.type !== "rate-limit") return currentItem;
        return {
          ...currentItem,
          violation: { ...currentItem.violation, ...body.data },
        };
      }));
    }
  }

  const sortedItems = useMemo(() => sortAbuseFeed(items, sortMode), [items, sortMode]);

  if (!adminKey) {
    return (
      <main className="admin-login" aria-label="Admin login">
        <form className="admin-card admin-login-card" onSubmit={authenticate}>
          <p className="admin-eyebrow">Velo operations</p>
          <h1>Abuse prevention</h1>
          <p>Enter the internal admin API key to continue.</p>
          <label htmlFor="admin-key">Admin API key</label>
          <input
            id="admin-key"
            type="password"
            autoComplete="off"
            value={keyInput}
            onChange={event => setKeyInput(event.target.value)}
          />
          <button type="submit" disabled={loading}>{loading ? "Validating…" : "Continue"}</button>
          {error && <p role="alert">{error}</p>}
        </form>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="admin-eyebrow">Velo operations</p>
          <h1>Abuse prevention</h1>
          <p>Fraud flags and rate-limit violations in one queue.</p>
        </div>
        <button className="admin-secondary" onClick={logout}>Sign out</button>
      </header>

      <section className="admin-toolbar" aria-label="Feed controls">
        <label htmlFor="feed-sort">Sort by</label>
        <select id="feed-sort" value={sortMode} onChange={event => setSortMode(event.target.value as SortMode)}>
          <option value="recency">Most recent</option>
          <option value="severity">Highest severity</option>
        </select>
        <label htmlFor="operator-name">Operator</label>
        <input id="operator-name" value={operatorName} onChange={event => setOperatorName(event.target.value)} />
      </section>

      {error && <p className="admin-error" role="alert">{error}</p>}
      {loading ? <p>Loading abuse feed…</p> : (
        <ol className="abuse-feed" aria-label="Unified abuse feed">
          {sortedItems.map(item => (
            <li className="abuse-item" key={item.id} data-testid="feed-item">
              <div className="abuse-item-heading">
                <span className={`severity severity-${item.severity}`}>{item.severity}</span>
                <strong>{item.type === "fraud" ? "Fraud flag" : "Rate-limit violation"}</strong>
                <time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString()}</time>
              </div>
              {item.type === "fraud" ? (
                <>
                  <p>Trade <code>{item.trade.id}</code> · {item.trade.status}</p>
                  {item.trade.suspicion_notes && <p>{item.trade.suspicion_notes}</p>}
                  <button onClick={() => actOnItem(item)}>Dismiss fraud flag</button>
                </>
              ) : (
                <>
                  <p><code>{item.violation.method} {item.violation.route}</code></p>
                  <p>{item.violation.identifier} · {item.violation.offense_count} blocked request(s)</p>
                  <button
                    onClick={() => actOnItem(item)}
                    disabled={item.violation.status === "resolved"}
                  >
                    {item.violation.status === "resolved" ? "Resolved" : "Resolve violation"}
                  </button>
                </>
              )}
            </li>
          ))}
          {sortedItems.length === 0 && <li className="admin-empty">No abuse-prevention items.</li>}
        </ol>
      )}
    </main>
  );
}
