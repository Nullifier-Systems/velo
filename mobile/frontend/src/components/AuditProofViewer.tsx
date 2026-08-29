import React, { useState } from 'react';
import { AuditInclusionProof } from '@stellar/velo-shared';

export const AuditProofViewer: React.FC<{ eventId: string }> = ({ eventId }) => {
    const [proof, setProof] = useState<AuditInclusionProof | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const loadProof = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/v1/audit/proof/${eventId}`);
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to load proof');
            }
            const data: AuditInclusionProof = await res.json();
            setProof(data);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="audit-proof-viewer p-4 border rounded shadow">
            <h3 className="text-xl font-bold mb-4">Audit Inclusion Proof</h3>
            <button 
                onClick={loadProof} 
                disabled={loading}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
            >
                {loading ? 'Loading...' : 'Verify Event on Stellar'}
            </button>

            {error && <div className="text-red-500 mt-2">{error}</div>}

            {proof && (
                <div className="mt-4 space-y-2">
                    <div><strong>Status:</strong> {proof.verified ? '✅ Verified' : '❌ Failed'}</div>
                    <div><strong>Event ID:</strong> {proof.eventId}</div>
                    <div><strong>Merkle Root:</strong> <span className="font-mono text-sm break-all">{proof.merkleRoot}</span></div>
                    <div><strong>Stellar Tx Hash:</strong> <span className="font-mono text-sm break-all">{proof.stellarTxHash}</span></div>
                    
                    <h4 className="font-semibold mt-4">Merkle Proof Path</h4>
                    <ul className="list-disc pl-5 font-mono text-xs">
                        {proof.proof.map((p, idx) => (
                            <li key={idx} className="break-all">{p}</li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};
