import { useEffect, useState } from "react";
import OutlineButton from "../components/OutlineButton.js";

interface Approval {
  id: string;
  tenant_id: string;
  amount_stroops: string;
  initiator_id: string;
  status: string;
}

export default function EnterpriseApprovals() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const apiBase = import.meta.env.VITE_API_URL ?? "";

  async function load() {
    if (!tenantId) return;
    setError(null);
    const res = await fetch(`${apiBase}/api/v1/enterprise/approvals?tenant_id=${tenantId}`);
    const j = await res.json();
    if (!res.ok) setError(j.error ?? "Load failed");
    else setApprovals(j.data ?? []);
  }

  useEffect(() => {
    if (tenantId) void load();
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function approve(id: string) {
    setError(null);
    const res = await fetch(`${apiBase}/api/v1/enterprise/approvals/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: tenantId, approval_id: id, approver_id: "approver-1", kms_provider: "aws", kms_key_id: "test-key" }),
    });
    const j = await res.json();
    if (res.ok) load();
    else setError(j.error ?? "Approve failed");
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <p style={{ color: "#5a6660", fontSize: ".85rem", fontWeight: 600 }}>Velo enterprise</p>
          <h1>Dual approvals</h1>
          <p>4-eyes approval queue — high-value escrows require a different approver.</p>
        </div>
        <OutlineButton href="/enterprise">Back to orgs</OutlineButton>
      </header>

      <section className="admin-toolbar" aria-label="Approvals filter">
        <label htmlFor="tenant-id">Tenant ID</label>
        <input id="tenant-id" value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="tenant_id" style={{ letterSpacing: "0.02em", fontWeight: 500 }} />
        <OutlineButton outline onClick={load}>Refresh</OutlineButton>
      </section>

      {error && <p className="admin-error" role="alert">{error}</p>}

      <ol className="abuse-feed" aria-label="Pending approvals">
        {approvals.map((a) => (
          <li key={a.id} className="abuse-item">
            <div className="abuse-item-heading">
              <span className="severity severity-high">PENDING</span>
              <strong>{a.id.slice(0, 8)}…</strong>
              <time>{a.amount_stroops} stroops</time>
            </div>
            <p style={{ fontFamily: "var(--font-mono)", fontSize: ".85rem" }}>Initiator: {a.initiator_id}</p>
            <OutlineButton outline onClick={() => approve(a.id)}>Approve (4-eyes)</OutlineButton>
          </li>
        ))}
        {approvals.length === 0 && <li className="admin-empty">No pending approvals.</li>}
      </ol>
    </main>
  );
}
