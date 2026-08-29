import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api, IndexerStatus, IndexerDagResponse } from "../lib/api";

interface BlockHeader {
  ledger_sequence: number;
  block_hash: string;
  parent_hash: string;
  created_at: string;
}

interface LedgerDagViewerProps {
  /** Number of recent ledgers to display (default: 20) */
  limit?: number;
  /** Whether to auto-refresh (default: true) */
  autoRefresh?: boolean;
  /** Refresh interval in milliseconds (default: 5000) */
  refreshInterval?: number;
  /** Height of the visualization in pixels (default: 400) */
  height?: number;
}

export function LedgerDagViewer({
  limit = 20,
  autoRefresh = true,
  refreshInterval = 5000,
  height = 400,
}: LedgerDagViewerProps) {
  const { t } = useTranslation();
  const [blockHeaders, setBlockHeaders] = useState<BlockHeader[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLedger, setSelectedLedger] = useState<BlockHeader | null>(null);

  useEffect(() => {
    fetchBlockHeaders();
    if (autoRefresh) {
      const interval = setInterval(fetchBlockHeaders, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, refreshInterval]);

  const fetchBlockHeaders = async () => {
    try {
      setLoading(true);
      const adminKey = process.env.VITE_ADMIN_API_KEY;
      const latestHeader = await api.get<IndexerStatus>("/indexer/status", adminKey);
      const latestSequence = latestHeader.data.latestBlockHeader?.ledger_sequence || 0;
      
      if (latestSequence === 0) {
        setBlockHeaders([]);
        setError(null);
        return;
      }

      const fromLedger = Math.max(0, latestSequence - limit + 1);
      const response = await api.get<IndexerDagResponse>(`/indexer/dag?fromLedger=${fromLedger}&toLedger=${latestSequence}`, adminKey);
      
      setBlockHeaders(response.data.headers || []);
      setError(null);
    } catch (err) {
      setError("Failed to fetch block headers");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = () => {
    fetchBlockHeaders();
  };

  // Generate a color based on block hash for visual distinction
  const getBlockColor = (hash: string) => {
    let hashNum = 0;
    for (let i = 0; i < hash.length; i++) {
      hashNum = hash.charCodeAt(i) + ((hashNum << 5) - hashNum);
    }
    const hue = Math.abs(hashNum % 360);
    return `hsl(${hue}, 70%, 50%)`;
  };

  if (loading && blockHeaders.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">{t('indexer.dagVisualization')}</h3>
        <div className="flex items-center justify-center" style={{ height }}>
          <div className="text-gray-500">{t('indexer.loadingLedgerHeaders')}</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">{t('indexer.dagVisualization')}</h3>
          <button
            onClick={handleRefresh}
            className="text-blue-600 hover:text-blue-800 text-sm"
          >
            {t('indexer.retry')}
          </button>
        </div>
        <div className="flex items-center justify-center" style={{ height }}>
          <div className="text-red-500">{error}</div>
        </div>
      </div>
    );
  }

  if (blockHeaders.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">{t('indexer.dagVisualization')}</h3>
        <div className="flex items-center justify-center" style={{ height }}>
          <div className="text-gray-500">{t('indexer.noBlockHeadersAvailable')}</div>
        </div>
      </div>
    );
  }

  // Sort by ledger sequence
  const sortedHeaders = [...blockHeaders].sort((a, b) => a.ledger_sequence - b.ledger_sequence);

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">{t('indexer.dagVisualization')}</h3>
        <button
          onClick={handleRefresh}
          className="text-blue-600 hover:text-blue-800 text-sm"
          disabled={loading}
        >
          {loading ? t('indexer.refreshing') : t('indexer.refresh')}
        </button>
      </div>

      {/* SVG Visualization */}
      <div className="relative" style={{ height }}>
        <svg width="100%" height="100%" className="border rounded">
          {/* Draw connections between blocks */}
          {sortedHeaders.map((header, index) => {
            if (index === 0) return null; // No parent for first block
            
            const parentHeader = sortedHeaders.find(h => h.block_hash === header.parent_hash);
            if (!parentHeader) return null;

            const x1 = ((index - 1) / (sortedHeaders.length - 1 || 1)) * 100 + 5;
            const y1 = 50;
            const x2 = (index / (sortedHeaders.length - 1 || 1)) * 100 + 5;
            const y2 = 50;

            return (
              <line
                key={`line-${header.ledger_sequence}`}
                x1={`${x1}%`}
                y1={y1}
                x2={`${x2}%`}
                y2={y2}
                stroke="#94a3b8"
                strokeWidth="2"
              />
            );
          })}

          {/* Draw blocks */}
          {sortedHeaders.map((header, index) => {
            const x = (index / (sortedHeaders.length - 1 || 1)) * 100 + 5;
            const y = 50;
            const isSelected = selectedLedger?.ledger_sequence === header.ledger_sequence;

            return (
              <g
                key={header.ledger_sequence}
                onClick={() => setSelectedLedger(header)}
                style={{ cursor: "pointer" }}
              >
                {/* Block circle */}
                <circle
                  cx={`${x}%`}
                  cy={y}
                  r={isSelected ? 12 : 8}
                  fill={getBlockColor(header.block_hash)}
                  stroke={isSelected ? "#1e40af" : "#64748b"}
                  strokeWidth={isSelected ? 3 : 2}
                />
                
                {/* Ledger number */}
                <text
                  x={`${x}%`}
                  y={y + 25}
                  textAnchor="middle"
                  className="text-xs"
                  fill="#475569"
                >
                  {header.ledger_sequence}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Selected block details */}
      {selectedLedger && (
        <div className="mt-4 p-4 bg-gray-50 rounded-lg">
          <h4 className="font-medium mb-2">{t('indexer.blockDetails')}</h4>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-600">{t('indexer.ledgerSequence')}</span>
              <span className="ml-2 font-mono">{selectedLedger.ledger_sequence}</span>
            </div>
            <div>
              <span className="text-gray-600">{t('indexer.created')}</span>
              <span className="ml-2">{new Date(selectedLedger.created_at).toLocaleString()}</span>
            </div>
            <div className="col-span-2">
              <span className="text-gray-600">{t('indexer.blockHash')}</span>
              <span className="ml-2 font-mono text-xs break-all">{selectedLedger.block_hash}</span>
            </div>
            <div className="col-span-2">
              <span className="text-gray-600">{t('indexer.parentHash')}</span>
              <span className="ml-2 font-mono text-xs break-all">{selectedLedger.parent_hash}</span>
            </div>
          </div>
          <button
            onClick={() => setSelectedLedger(null)}
            className="mt-2 text-sm text-blue-600 hover:text-blue-800"
          >
            {t('indexer.closeDetails')}
          </button>
        </div>
      )}

      {/* Legend */}
      <div className="mt-4 flex items-center gap-4 text-sm text-gray-600">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full bg-blue-500" />
          <span>{t('indexer.selected')}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-gray-400" />
          <span>{t('indexer.normal')}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-8 h-0.5 bg-gray-400" />
          <span>{t('indexer.parentChildLink')}</span>
        </div>
      </div>

      {/* Stats */}
      <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
        <div className="text-center">
          <div className="font-semibold">{sortedHeaders.length}</div>
          <div className="text-gray-600">{t('indexer.blocks')}</div>
        </div>
        <div className="text-center">
          <div className="font-semibold">
            {sortedHeaders.length > 0 
              ? sortedHeaders[sortedHeaders.length - 1].ledger_sequence - sortedHeaders[0].ledger_sequence + 1
              : 0}
          </div>
          <div className="text-gray-600">{t('indexer.ledgerRange')}</div>
        </div>
        <div className="text-center">
          <div className="font-semibold">{limit}</div>
          <div className="text-gray-600">{t('indexer.displayLimit')}</div>
        </div>
      </div>
    </div>
  );
}
