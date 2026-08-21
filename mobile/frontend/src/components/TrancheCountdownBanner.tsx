import React from 'react';

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
  if (status === 'REFUND_EXECUTED') {
    return (
      <div className="bg-green-100 p-4 rounded-md text-green-800">
        <p>Unreleased Tranches Refunded to Buyer</p>
      </div>
    );
  }

  const releasedFraction = (totalTranches - unreleasedTranches) / totalTranches;
  const isWarning = ledgersRemaining < 50;

  return (
    <div className="bg-blue-50 p-4 rounded-md text-blue-900 shadow">
      <div className="flex items-center justify-between mb-2">
        <h4 className="font-semibold flex items-center">
          {isWarning && <span className="text-yellow-500 mr-2">⚠️</span>}
          {ledgersRemaining} Ledgers Remaining (~{estimatedMinutes} mins) Until Partial Refund
        </h4>
      </div>
      
      <div className="w-full bg-gray-200 rounded-full h-2.5">
        <div 
          className="bg-blue-600 h-2.5 rounded-full transition-all" 
          style={{ width: \`\${releasedFraction * 100}%\` }}
        />
      </div>
      <div className="text-xs text-gray-500 mt-1 text-right">
        {totalTranches - unreleasedTranches} / {totalTranches} Tranches Released
      </div>
    </div>
  );
};
