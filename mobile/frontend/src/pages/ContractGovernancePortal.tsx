import { FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const apiBase = import.meta.env.VITE_API_URL ?? "";

export interface UpgradeProposalRecord {
  proposal_id: string;
  contract_id: string;
  new_wasm_hash: string;
  storage_version: number;
  signatures_collected: number;
  executed: boolean;
  created_at: string;
}

export function validateContractId(value: string): boolean {
  return value.trim().length === 56 && value.startsWith("C");
}

export function validateWasmHash(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value.trim());
}

export default function ContractGovernancePortal() {
  const { t } = useTranslation();
  const [adminKey, setAdminKey] = useState<string>("");
  const [contractId, setContractId] = useState<string>("");
  const [newWasmHash, setNewWasmHash] = useState<string>("");
  const [targetVersion, setTargetVersion] = useState<number>(2);

  // Multi-sig signer state (2-of-3 threshold)
  const [signer1Address, setSigner1Address] = useState<string>("");
  const [signer1Signature, setSigner1Signature] = useState<string>("");
  const [signer2Address, setSigner2Address] = useState<string>("");
  const [signer2Signature, setSigner2Signature] = useState<string>("");

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [proposals, setProposals] = useState<UpgradeProposalRecord[]>([]);

  const fetchProposals = async () => {
    try {
      const res = await fetch(`${apiBase}/api/v1/admin/contracts/proposals`, {
        headers: { "x-admin-api-key": adminKey },
      });
      if (res.ok) {
        const data = await res.json();
        setProposals(data.proposals ?? []);
      }
    } catch {
      // Offline / dev fallback
    }
  };

  useEffect(() => {
    if (adminKey) {
      void fetchProposals();
    }
  }, [adminKey]);

  const handleUpgradeSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);

    if (!adminKey) {
      setErrorMessage("Admin API key is required");
      return;
    }
    if (!validateContractId(contractId)) {
      setErrorMessage("Invalid Soroban contract address (must be 56-char starting with 'C')");
      return;
    }
    if (!validateWasmHash(newWasmHash)) {
      setErrorMessage("Invalid WASM code hash (must be 64-char hex SHA-256)");
      return;
    }
    if (!signer1Address || !signer1Signature || !signer2Address || !signer2Signature) {
      setErrorMessage("At least 2 admin signatures are required for multi-sig upgrade governance");
      return;
    }
    if (signer1Address === signer2Address) {
      setErrorMessage("Signers must be distinct administrative keys");
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        contractId,
        newWasmHash,
        storageVersion: targetVersion,
        signatures: [
          { signerAddress: signer1Address, signature: signer1Signature },
          { signerAddress: signer2Address, signature: signer2Signature },
        ],
      };

      const res = await fetch(`${apiBase}/api/v1/admin/contracts/upgrade`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-api-key": adminKey,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.code || "Failed to execute contract upgrade");
      }

      setStatusMessage(`Contract successfully upgraded! Tx Hash: ${data.txHash} (Version ${data.storageVersion})`);
      void fetchProposals();
    } catch (err: any) {
      setErrorMessage(err.message ?? "Unknown error during upgrade execution");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="contract-governance-portal" style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>
      <header style={{ marginBottom: "24px" }}>
        <h1>Contract Upgradability & Governance Portal</h1>
        <p style={{ color: "#666" }}>
          Soroban smart contract code hash upgrades and storage state migration engine (Issue #464).
        </p>
      </header>

      {/* Admin Key Setup */}
      <section style={{ marginBottom: "24px", padding: "16px", border: "1px solid #ddd", borderRadius: "8px" }}>
        <h3>Admin Authentication</h3>
        <input
          type="password"
          placeholder="Enter x-admin-api-key"
          value={adminKey}
          onChange={(e) => setAdminKey(e.target.value)}
          style={{ width: "100%", padding: "8px", marginTop: "8px", boxSizing: "border-box" }}
        />
      </section>

      {/* Upgrade Proposal Form */}
      <section style={{ marginBottom: "24px", padding: "16px", border: "1px solid #ddd", borderRadius: "8px" }}>
        <h3>Propose & Execute Smart Contract Upgrade</h3>
        <form onSubmit={handleUpgradeSubmit}>
          <div style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", fontWeight: 600 }}>Target Contract ID (Soroban Address)</label>
            <input
              type="text"
              placeholder="e.g. CBJQHRGVAHLN5ZEIAIEBMR63Y2HVHUDZPRE6ZFULBS7LE756AT5ZIAGG"
              value={contractId}
              onChange={(e) => setContractId(e.target.value)}
              style={{ width: "100%", padding: "8px", marginTop: "4px", boxSizing: "border-box" }}
              required
            />
          </div>

          <div style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", fontWeight: 600 }}>New Compiled WASM Code Hash (SHA-256)</label>
            <input
              type="text"
              placeholder="e.g. 7f3b89a9c8d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7"
              value={newWasmHash}
              onChange={(e) => setNewWasmHash(e.target.value)}
              style={{ width: "100%", padding: "8px", marginTop: "4px", boxSizing: "border-box" }}
              required
            />
          </div>

          <div style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", fontWeight: 600 }}>Target Storage Schema Version</label>
            <input
              type="number"
              min={1}
              value={targetVersion}
              onChange={(e) => setTargetVersion(parseInt(e.target.value, 10))}
              style={{ width: "100%", padding: "8px", marginTop: "4px", boxSizing: "border-box" }}
              required
            />
          </div>

          {/* Multi-Sig Signatures */}
          <div style={{ marginTop: "16px", padding: "12px", background: "#f8f9fa", borderRadius: "6px" }}>
            <h4>Multi-Sig Threshold Signatures (2-of-3 Required)</h4>

            <div style={{ marginBottom: "8px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600 }}>Signer 1 Public Key</label>
              <input
                type="text"
                placeholder="G..."
                value={signer1Address}
                onChange={(e) => setSigner1Address(e.target.value)}
                style={{ width: "100%", padding: "6px", boxSizing: "border-box" }}
              />
              <label style={{ fontSize: "12px", fontWeight: 600, marginTop: "4px", display: "block" }}>Signer 1 Signature</label>
              <input
                type="text"
                placeholder="Hex signature"
                value={signer1Signature}
                onChange={(e) => setSigner1Signature(e.target.value)}
                style={{ width: "100%", padding: "6px", boxSizing: "border-box" }}
              />
            </div>

            <div style={{ marginTop: "12px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600 }}>Signer 2 Public Key</label>
              <input
                type="text"
                placeholder="G..."
                value={signer2Address}
                onChange={(e) => setSigner2Address(e.target.value)}
                style={{ width: "100%", padding: "6px", boxSizing: "border-box" }}
              />
              <label style={{ fontSize: "12px", fontWeight: 600, marginTop: "4px", display: "block" }}>Signer 2 Signature</label>
              <input
                type="text"
                placeholder="Hex signature"
                value={signer2Signature}
                onChange={(e) => setSigner2Signature(e.target.value)}
                style={{ width: "100%", padding: "6px", boxSizing: "border-box" }}
              />
            </div>
          </div>

          {errorMessage && (
            <div style={{ marginTop: "12px", padding: "8px", background: "#fee", color: "#c00", borderRadius: "4px" }}>
              {errorMessage}
            </div>
          )}

          {statusMessage && (
            <div style={{ marginTop: "12px", padding: "8px", background: "#efe", color: "#080", borderRadius: "4px" }}>
              {statusMessage}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              marginTop: "16px",
              padding: "10px 20px",
              background: "#0066cc",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: isSubmitting ? "not-allowed" : "pointer",
            }}
          >
            {isSubmitting ? "Submitting Upgrade..." : "Submit Upgrade & Migrate"}
          </button>
        </form>
      </section>

      {/* Audit History */}
      <section style={{ padding: "16px", border: "1px solid #ddd", borderRadius: "8px" }}>
        <h3>Contract Upgrade History</h3>
        {proposals.length === 0 ? (
          <p style={{ color: "#888" }}>No contract upgrade proposals recorded yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "12px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                <th style={{ padding: "8px" }}>Contract</th>
                <th style={{ padding: "8px" }}>WASM Hash</th>
                <th style={{ padding: "8px" }}>Version</th>
                <th style={{ padding: "8px" }}>Signatures</th>
                <th style={{ padding: "8px" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => (
                <tr key={p.proposal_id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "8px", fontFamily: "monospace" }}>{p.contract_id.slice(0, 8)}...</td>
                  <td style={{ padding: "8px", fontFamily: "monospace" }}>{p.new_wasm_hash.slice(0, 10)}...</td>
                  <td style={{ padding: "8px" }}>v{p.storage_version}</td>
                  <td style={{ padding: "8px" }}>{p.signatures_collected} / 3</td>
                  <td style={{ padding: "8px", color: p.executed ? "green" : "orange" }}>
                    {p.executed ? "EXECUTED" : "PENDING"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
