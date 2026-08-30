import React, { useState } from 'react';
import { AuditInclusionProof } from '@velo/shared';
import { useTranslation } from "react-i18next";

export const AuditProofViewer: React.FC<{ eventId: string }> = ({ eventId }) => {
    const { t } = useTranslation();
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
                throw new Error(data.error || t('common.error'));
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
            <h3 className="text-xl font-bold mb-4">{t('auditVault.proofTitle')}</h3>
            <button 
                onClick={loadProof} 
                disabled={loading}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
            >
                {loading ? t('auditVault.loading') : t('auditVault.verifyBtn')}
            </button>

            {error && <div className="text-red-500 mt-2">{error}</div>}

            {proof && (
                <div className="mt-4 space-y-2">
                    <div><strong>{t('auditVault.status')}</strong> {proof.verified ? t('auditVault.verified') : t('auditVault.failed')}</div>
                    <div><strong>{t('auditVault.eventId')}</strong> {proof.eventId}</div>
                    <div><strong>{t('auditVault.merkleRoot')}</strong> <span className="font-mono text-sm break-all">{proof.merkleRoot}</span></div>
                    <div><strong>{t('auditVault.stellarTxHash')}</strong> <span className="font-mono text-sm break-all">{proof.stellarTxHash}</span></div>
                    
                    <h4 className="font-semibold mt-4">{t('auditVault.merklePath')}</h4>
                    <ul className="list-disc pl-5 font-mono text-xs">
                        {proof.proof.map((p: string, idx: number) => (
                            <li key={idx} className="break-all">{p}</li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};
