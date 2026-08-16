import { FormEvent, useEffect, useMemo, useState } from "react";
import "./AdminCircuitBreakerDashboard.css";

const apiBase = import.meta.env.VITE_API_URL ?? "";

type StreamStatus = "connected" | "disconnected";
type OverrideAction = "FORCE_PAUSE" | "UNPAUSE";
type ContractStatus = "HEALTHY" | "WARNING" | "VIOLATED" | "HALTED";

export interface CircuitBreakerState {
  contractId: string;
  totalLockedStroops: string;
  totalAllocatedStroops: string;
  feeAccumulatorStroops: string;
  lastProcessedLedger: number;
  status: ContractStatus;
}

export interface CircuitBreakerIncident {
  incidentId: string;
  contractId: string;
  violatedInvariant: string;
  actionTaken: string;
  txPauseHash?: string | null;
  resolvedAt?: string | null;
}

export interface CircuitBreakerStream {
  getStatus: () => StreamStatus;
  reconnect: () => void;
}

/** Soroban contract addresses are 56-char Stellar `C...` strings. */
export function validateContractId(value: string): boolean {
  return value.trim().length === 56;
}

const defaultStream: CircuitBreakerStream = {
  getStatus: () => "connected",
  reconnect: () => undefined,
};

interface OverrideModalState {
  action: OverrideAction;
}

export default function AdminCircuitBreakerDashboard({
  stream = defaultStream,
}: {
  stream?: CircuitBreakerStream;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [adminKey, setAdminKey] = useState<string | null>(null);
  const [contractId, setContractId] = useState("");
  const [contractError, setContractError] = useState<string | null>(null);
  const [state, setState] = useState<CircuitBreakerState | null>(null);
  const [incidents, setIncidents] = useState<CircuitBreakerIncident[]>([]);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>(() => stream.getStatus());
  const [modal, setModal] = useState<OverrideModalState | null>(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const logout = () => {
    setAdminKey(null);
    setKeyInput("");
    setContractId("");
    setContractError(null);
    setState(null);
    setIncidents([]);
    setError(null);
    setLastTx(null);
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
    } catch {
      setError("Admin dashboard is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  async function loadData(key: string, contract: string): Promise<void> {
    try {
      const [stateResponse, incidentsResponse] = await Promise.all([
        request(`/api/v1/admin/circuit-breaker/state?contractId=${contract}`, key),
        request(`/api/v1/admin/circuit-breaker/incidents?contractId=${contract}`, key),
      ]);
      if (stateResponse.status === 401 || incidentsResponse.status === 401) return;
      if (!stateResponse.ok || !incidentsResponse.ok) throw new Error("Failed to load circuit-breaker state.");
      const stateBody = await stateResponse.json();
      const incidentsBody = await incidentsResponse.json();
      setState(stateBody.data ?? null);
      setIncidents(incidentsBody.data ?? []);
      setStreamStatus("connected");
      setError(null);
    } catch {
      setStreamStatus("disconnected");
      setError("Ledger stream unreachable. The circuit-breaker dashboard is out of sync.");
    }
  }

  function handleContractBlur(): void {
    const value = contractId.trim();
    if (!value) {
      setState(null);
      setContractError(null);
      return;
    }
    if (!validateContractId(value)) {
      setContractError("Contract ID must be 56 characters.");
      setState(null);
      return;
    }
    setContractError(null);
    if (adminKey) void loadData(adminKey, value);
  }

  function reconnectStream(): void {
    stream.reconnect();
    setStreamStatus("connected");
    if (adminKey && validateContractId(contractId)) {
      void loadData(adminKey, contractId.trim());
    }
  }

  async function submitOverride(action: OverrideAction): Promise<void> {
    if (!adminKey) return;
    setLoading(true);
    setError(null);
    setLastTx(null);
    try {
      const response = await request("/api/v1/admin/circuit-breaker/override", adminKey, {
        method: "POST",
        headers: { "x-admin-operator-name": "Circuit Breaker Admin" },
        body: JSON.stringify({
          contractId: contractId.trim(),
          action,
          reason: reason.trim(),
        }),
      });
      if (response.status === 401) return;
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.message ?? "Override failed.");
        return;
      }
      const body = await response.json();
      setLastTx(body.txHash ?? null);
      setModal(null);
      setReason("");
      setState(current => (current ? { ...current, status: body.newStatus } : current));
      await loadData(adminKey, contractId.trim());
    } catch {
      setError("Circuit-breaker override is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = setInterval(() => setStreamStatus(stream.getStatus()), 2000);
    return () => clearInterval(timer);
  }, [stream]);

  const isHalted = state?.status === "HALTED";
  const reasonValid = useMemo(() => reason.trim().length >= 10, [reason]);

  if (!adminKey) {
    return (
      <main className="admin-login" aria-label="Admin login">
        <form className="admin-card admin-login-card" onSubmit={authenticate}>
          <p className="admin-eyebrow">Velo operations</p>
          <h1>Circuit breaker</h1>
          <p>Enter the internal admin API key to continue.</p>
          <label htmlFor="cb-admin-key">Admin API key</label>
          <input
            id="cb-admin-key"
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
    <main className="cb-shell">
      <header className="cb-header">
        <div>
          <p className="admin-eyebrow">Velo operations</p>
          <h1>Circuit breaker</h1>
          <p>Automated reserve-conservation monitoring and manual override.</p>
        </div>
        <button className="admin-secondary" onClick={logout}>Sign out</button>
      </header>

      {streamStatus === "disconnected" && (
        <section className="cb-banner cb-banner-stream" role="alert">
          <p>Ledger stream is disconnected. Monitoring is paused.</p>
          <button onClick={reconnectStream}>Reconnect Stream</button>
        </section>
      )}

      <section className="cb-contract">
        <label htmlFor="cb-contract-id">Contract ID</label>
        <input
          id="cb-contract-id"
          value={contractId}
          onChange={event => setContractId(event.target.value)}
          onBlur={handleContractBlur}
          placeholder="C…"
        />
        {contractError && <p className="cb-error" role="alert">{contractError}</p>}
      </section>

      {error && <p className="cb-error" role="alert">{error}</p>}
      {lastTx && <p className="cb-success">Broadcast tx: <code>{lastTx}</code></p>}

      {state && (
        <>
          <section className={isHalted ? "cb-status cb-status-halted" : "cb-status"} data-testid="cb-status">
            <div>
              <span className={`severity severity-${state.status.toLowerCase()}`}>{state.status}</span>
              <strong>{state.contractId}</strong>
            </div>
            <dl className="cb-metrics">
              <div><dt>Locked</dt><dd>{state.totalLockedStroops}</dd></div>
              <div><dt>Allocated</dt><dd>{state.totalAllocatedStroops}</dd></div>
              <div><dt>Fees</dt><dd>{state.feeAccumulatorStroops}</dd></div>
              <div><dt>Last ledger</dt><dd>{state.lastProcessedLedger}</dd></div>
            </dl>
            <div className="cb-actions">
              <button
                onClick={() => { setModal({ action: "FORCE_PAUSE" }); setReason(""); }}
                disabled={state.status === "HALTED"}
              >
                Force pause
              </button>
              <button
                className="admin-secondary"
                onClick={() => { setModal({ action: "UNPAUSE" }); setReason(""); }}
                disabled={state.status !== "HALTED"}
              >
                Unpause
              </button>
            </div>
          </section>

          <section className="cb-incidents">
            <h2>Incident log</h2>
            <ol aria-label="Circuit-breaker incidents">
              {incidents.map(incident => (
                <li key={incident.incidentId} data-testid="cb-incident">
                  <code>{incident.violatedInvariant}</code>
                  <span>{incident.actionTaken}</span>
                  {incident.txPauseHash && <code>{incident.txPauseHash}</code>}
                </li>
              ))}
              {incidents.length === 0 && <li className="admin-empty">No incidents recorded.</li>}
            </ol>
          </section>
        </>
      )}

      {modal && (
        <div className="cb-modal" role="dialog" aria-modal="true" aria-label="Confirm circuit-breaker override">
          <form
            className="cb-modal-card"
            onSubmit={event => {
              event.preventDefault();
              if (reasonValid) void submitOverride(modal.action);
            }}
          >
            <h2>Confirm {modal.action === "FORCE_PAUSE" ? "pause" : "unpause"}</h2>
            <p>This broadcasts an emergency {modal.action} for <code>{contractId}</code> on-chain.</p>
            <label htmlFor="cb-reason">Override reason</label>
            <textarea
              id="cb-reason"
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder="Minimum 10 characters…"
            />
            <div className="cb-modal-actions">
              <button type="button" className="admin-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" disabled={!reasonValid || loading}>
                {loading ? "Broadcasting…" : `Confirm ${modal.action === "FORCE_PAUSE" ? "pause" : "unpause"}`}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
