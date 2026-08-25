import React from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  totalTranches: number;
  unreleasedTranches: number;
  ledgersRemaining: number;
  estimatedMinutes: number;
  status: 'PENDING' | 'WARNING_SENT' | 'REFUND_EXECUTED';
}

export const TrancheCountdownBanner: React.FC<Props> = ({
  totalTranches,
  unreleasedTranches,
  ledgersRemaining,
  estimatedMinutes,
  status
}) => {
  const { t } = useTranslation();

  if (status === 'REFUND_EXECUTED') {
    return (
      <div className="bg-green-100 p-4 rounded-md text-green-800">
        <p>{t('tranche.unreleasedRefunded')}</p>
      </div>
    );
  }

  const releasedFraction =
    totalTranches > 0 ? (totalTranches - unreleasedTranches) / totalTranches : 0;
  const isWarning = ledgersRemaining < 50;
  const progressWidth = `${releasedFraction * 100}%`;

  return (
    <div className="bg-blue-50 p-4 rounded-md text-blue-900 shadow">
      <div className="flex items-center justify-between mb-2">
        <h4 className="font-semibold flex items-center">
          {isWarning && <span className="text-yellow-500 mr-2">⚠️</span>}
          {t('tranche.ledgersRemaining', { ledgersRemaining, estimatedMinutes })}
        </h4>
      </div>

      <div className="w-full bg-gray-200 rounded-full h-2.5">
        <div
          className="bg-blue-600 h-2.5 rounded-full transition-all"
          style={{ width: progressWidth }}
        />
      </div>
      <div className="text-xs text-gray-500 mt-1 text-right">
        {t('tranche.tranchesReleased', {
          released: totalTranches - unreleasedTranches,
          total: totalTranches
        })}
      </div>
    </div>
  );
};
