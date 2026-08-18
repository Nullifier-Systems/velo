import React, { useState } from 'react';
import './SpatialNettingDashboard.css';
import { useTranslation, Trans } from 'react-i18next';

export const SpatialNettingDashboard: React.FC = () => {
    const { t } = useTranslation();
    const [secret, setSecret] = useState('');
    const [error, setError] = useState('');

    const handleBlur = () => {
        if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
            setError(t('spatialNetting.errors.invalidSecret', 'Secret preimage must be a valid 32-byte hex string'));
        } else {
            setError('');
        }
    };

    return (
        <div className="spatial-netting-dashboard">
            <div className="header">{t('spatialNetting.header')}</div>

            <div>
                <Trans i18nKey="spatialNetting.activeH3Cell" values={{ cell: '8828308281fffff', resolution: 8 }}>
                    Active H3 Cell: [ {{cell}} ] (Resolution {{resolution}})
                </Trans>
            </div>

            <div>{t('spatialNetting.nettingLoop')}</div>
            <div>{t('spatialNetting.clearedBalance')}</div>

            <div>
                <label htmlFor="htlc-secret">{t('spatialNetting.htlcLabel')}</label>
                <input
                    id="htlc-secret"
                    type="text"
                    value={secret}
                    onChange={e => setSecret(e.target.value)}
                    onBlur={handleBlur}
                />
            </div>
            {error && <div className="error">{error}</div>}

            <div className="progress-bar">[=========================>  ] 80%</div>
            <div>{t('spatialNetting.relayerState')}</div>

            <div className="actions">
                <button>{t('spatialNetting.abortNetting')}</button>
                <button>{t('spatialNetting.executeAtomicSwap')}</button>
            </div>

            {/* Warning banner simulation */}
            <div className="warning-banner" style={{ display: 'none' }}>
                {t('spatialNetting.htlcTimeout')}
                <button>{t('spatialNetting.revertCollateral')}</button>
            </div>
        </div>
    );
};
