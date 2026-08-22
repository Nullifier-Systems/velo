import { useEffect, useState } from "react";
import KmsKeySelector from "../components/KmsKeySelector.js";
import OutlineButton from "../components/OutlineButton.js";

interface Tenant {
  id: string;
  name: string;
}

export default function EnterpriseDashboard() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [kms, setKms] = useState<{ provider: "aws" | "gcp" | "vault"; keyId: string }>({ provider: "aws", keyId: "" });
  const apiBase = import.meta.env.VITE_API_URL ?? "";

  useEffect(() => {
    const saved = localStorage.getItem("velo:enterprise:orgName");
    if (saved) setName(saved);
  }, []);

  useEffect(() => {
    localStorage.setItem("velo:enterprise:orgName", name);
  }, [name]);

  useEffect(() => {
    fetch(`${apiBase}/api/v1/enterprise/orgs`)
      .then((r) => r.json())
      .then((j) => setTenants(j.data ?? []))
      .catch(() => undefined);
  }, [apiBase]);

  async function createOrg() {
    if (!name.trim()) {
      setNameError("Org name can't be empty");
      return;
    }
    setNameError(null);
    const res = await fetch(`${apiBase}/api/v1/enterprise/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const j = await res.json();
    if (res.ok) {
      setTenants((t) => [j.data, ...t]);
      setName("");
      localStorage.removeItem("velo:enterprise:orgName");
    } else {
      setNameError(j.error ?? "Failed to create organization");
    }
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <p style={{ color: "#5a6660", fontSize: ".85rem", fontWeight: 600 }}>Velo enterprise</p>
          <h1>Organizations</h1>
          <p>Multi-tenant org management & KMS delegation.</p>
        </div>
        <OutlineButton href="/enterprise/approvals">View approvals</OutlineButton>
      </header>

      <section className="admin-toolbar" aria-label="Create organization">
        <label htmlFor="org-name">
          Organization<span style={{ color: "var(--status-refunded)" }}>*</span>
        </label>
        <input
          id="org-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
          placeholder="Organization name"
          style={{ letterSpacing: "0.02em", fontWeight: 500 }}
          aria-invalid={Boolean(nameError)}
        />
        <OutlineButton outline onClick={createOrg}>Create org</OutlineButton>
        <KmsKeySelector value={kms} onChange={setKms} />
      </section>
      {nameError && (
        <p className="admin-error" role="alert" style={{ marginTop: ".5rem" }}>
          {nameError}
        </p>
      )}

      <section style={{ marginTop: "1rem", display: "grid", gap: ".5rem" }}>
        <p style={{ color: "#5a6660", fontSize: ".85rem", letterSpacing: "0.02em", fontWeight: 600 }}>ABAC policy editor</p>
        <p style={{ color: "#5a6660", fontSize: ".9rem", fontFamily: "var(--font-sans)", letterSpacing: "0.01em" }}>
          Use POST /api/v1/enterprise/policies with tenant_id, role, action, expression (JSONB AST).
        </p>
      </section>

      <ol className="abuse-feed" aria-label="Organizations">
        {tenants.map((t) => (
          <li key={t.id} className="abuse-item">
            <div className="abuse-item-heading">
              <strong>{t.name}</strong>
              <span className="severity severity-low">tenant</span>
            </div>
            <p style={{ fontFamily: "var(--font-mono)", fontSize: ".85rem", wordBreak: "break-all" }}>{t.id}</p>
          </li>
        ))}
        {tenants.length === 0 && <li className="admin-empty">No organizations yet.</li>}
      </ol>
    </main>
  );
}
