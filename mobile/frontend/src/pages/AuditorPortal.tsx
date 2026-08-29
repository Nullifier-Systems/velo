import React, { useState } from 'react';
import { AuditProofViewer } from '../components/AuditProofViewer';

export default function AuditorPortal() {
    const [searchId, setSearchId] = useState('');
    const [activeEventId, setActiveEventId] = useState<string | null>(null);

    return (
        <div className="container mx-auto p-8 max-w-4xl">
            <div className="bg-slate-900 text-white rounded-t-lg p-6 flex justify-between items-center shadow-lg">
                <h1 className="text-3xl font-bold tracking-tight">Compliance & Audit Portal</h1>
                <div className="text-sm font-mono bg-slate-800 px-3 py-1 rounded">Tamper-Proof Vault Active</div>
            </div>
            
            <div className="bg-white p-6 shadow-lg rounded-b-lg border-x border-b border-gray-200">
                <p className="text-gray-600 mb-6">
                    Enter an Event Sequence ID to retrieve its cryptographically verifiable Merkle inclusion proof anchored on the Stellar network.
                </p>

                <div className="flex gap-4 mb-8">
                    <input 
                        type="text" 
                        placeholder="Event Sequence ID (e.g. 1005)" 
                        value={searchId}
                        onChange={e => setSearchId(e.target.value)}
                        className="flex-1 p-3 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none transition"
                    />
                    <button 
                        onClick={() => setActiveEventId(searchId)}
                        disabled={!searchId}
                        className="bg-slate-900 text-white px-6 py-3 rounded font-medium hover:bg-slate-800 transition disabled:opacity-50"
                    >
                        Search Log
                    </button>
                </div>

                {activeEventId && (
                    <div className="mt-8 animate-fade-in-up">
                        <AuditProofViewer eventId={activeEventId} />
                    </div>
                )}
            </div>
        </div>
    );
}
