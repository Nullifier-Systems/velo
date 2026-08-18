import React, { useState } from 'react';
import './SpatialNettingDashboard.css';

export const SpatialNettingDashboard: React.FC = () => {
    const [secret, setSecret] = useState('');
    const [error, setError] = useState('');

    const handleBlur = () => {
        if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
            setError('Secret preimage must be a valid 32-byte hex string');
        } else {
            setError('');
        }
    };

    return (
        <div className="spatial-netting-dashboard">
            <div className="header">H3 Spatial Liquidity Netting & Swaps</div>
            <div>Active H3 Cell: [ 8828308281fffff ] (Resolution 8)</div>
            <div>Netting Loop: Provider A ──► Provider B ──► Provider C</div>
            <div>Cleared Balance: $12,500.00 USDC</div>
            
            <div>
                HTLC Secret Key: 
                <input 
                    type="text" 
                    value={secret} 
                    onChange={e => setSecret(e.target.value)} 
                    onBlur={handleBlur} 
                />
            </div>
            {error && <div className="error">{error}</div>}
            
            <div className="progress-bar">[=========================>  ] 80%</div>
            <div>Relayer State: Propagating Secret Preimage On-Chain...</div>
            
            <div className="actions">
                <button>Abort Netting</button>
                <button>Execute Atomic Swap</button>
            </div>
            
            {/* Warning banner simulation */}
            <div className="warning-banner" style={{ display: 'none' }}>
                HTLC Timeout Triggered: Refund Protocol Active
                <button>Revert Collateral</button>
            </div>
        </div>
    );
};
