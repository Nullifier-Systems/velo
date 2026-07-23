import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "../components/LanguageSwitcher.js";

interface Trade {
  id: string;
  buyer: string;
  amount_stroops: string;
  status: string;
  created_at: string;
}

interface DashboardMetrics {
  total_trades: number;
  total_volume_usdc: string;
  fees_earned_usdc: string;
}

interface DashboardData {
  address: string;
  metrics: DashboardMetrics;
  trades: Trade[];
}

export default function Dashboard() {
  const { t } = useTranslation();
  const [address, setAddress] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = async (providerAddress: string) => {
    setLoading(true);
    setError(null);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
      const res = await fetch(`${apiUrl}/api/v1/provider/dashboard`, {
        headers: {
          'x-provider-address': providerAddress
        }
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const json = await res.json();
      setData(json);
      setIsAuthenticated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const exportData = async (format: 'csv' | 'json') => {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
      const res = await fetch(`${apiUrl}/api/v1/provider/export?format=${format}`, {
        headers: {
          'x-provider-address': address
        }
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `completed_trades_${address.substring(0, 8)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (address.trim()) {
      fetchDashboard(address.trim());
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md w-full space-y-8 bg-white p-8 rounded-xl shadow-sm border border-gray-100">
          <h2 className="text-center text-3xl font-extrabold text-gray-900">{t("dashboard.login")}</h2>
          <p className="text-center text-sm text-gray-600">{t("dashboard.loginDescription")}</p>
          <form className="mt-8 space-y-6" onSubmit={handleLogin}>
            <div>
              <input
                type="text"
                required
                className="appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="G..."
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              {loading ? t("dashboard.loadingButton") : t("dashboard.viewDashboard")}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <LanguageSwitcher />
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{t("dashboard.title")}</h1>
          <p className="mt-1 text-sm text-gray-500">{t("common.address")}: <span className="font-mono">{data?.address}</span></p>
          <button onClick={() => { setIsAuthenticated(false); setData(null); }} className="text-blue-600 text-sm mt-2">{t("dashboard.logout")}</button>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <div className="bg-white overflow-hidden shadow rounded-lg border border-gray-100">
            <div className="px-4 py-5 sm:p-6">
              <dt className="text-sm font-medium text-gray-500 truncate">{t("dashboard.totalTrades")}</dt>
              <dd className="mt-1 text-3xl font-semibold text-gray-900">{data?.metrics.total_trades}</dd>
            </div>
          </div>
          <div className="bg-white overflow-hidden shadow rounded-lg border border-gray-100">
            <div className="px-4 py-5 sm:p-6">
              <dt className="text-sm font-medium text-gray-500 truncate">{t("dashboard.totalVolume")}</dt>
              <dd className="mt-1 text-3xl font-semibold text-gray-900">${data?.metrics.total_volume_usdc}</dd>
            </div>
          </div>
          <div className="bg-white overflow-hidden shadow rounded-lg border border-gray-100">
            <div className="px-4 py-5 sm:p-6">
              <dt className="text-sm font-medium text-gray-500 truncate">{t("dashboard.estimatedFees")}</dt>
              <dd className="mt-1 text-3xl font-semibold text-green-600">${data?.metrics.fees_earned_usdc}</dd>
            </div>
          </div>
        </div>

        <div className="bg-white shadow overflow-hidden sm:rounded-md border border-gray-100">
          <div className="px-4 py-5 border-b border-gray-200 sm:px-6 flex items-center justify-between">
            <h3 className="text-lg leading-6 font-medium text-gray-900">{t("dashboard.recentTrades")}</h3>
            <div className="flex space-x-2">
              <button
                onClick={() => exportData('csv')}
                className="inline-flex items-center px-3 py-1.5 border border-gray-300 shadow-sm text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                {t("dashboard.exportCSV")}
              </button>
              <button
                onClick={() => exportData('json')}
                className="inline-flex items-center px-3 py-1.5 border border-gray-300 shadow-sm text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                {t("dashboard.exportJSON")}
              </button>
            </div>
          </div>
          <ul role="list" className="divide-y divide-gray-200">
            {data?.trades.length === 0 ? (
              <li className="px-4 py-4 sm:px-6 text-gray-500 text-sm">{t("dashboard.noTrades")}</li>
            ) : (
              data?.trades.map((trade) => (
                <li key={trade.id}>
                  <div className="px-4 py-4 sm:px-6">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-blue-600 truncate">{trade.id.substring(0, 8)}...</p>
                      <div className="ml-2 flex-shrink-0 flex">
                        <p className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                          {trade.status}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 sm:flex sm:justify-between">
                      <div className="sm:flex sm:items-center sm:gap-4">
                        <p className="flex items-center text-sm text-gray-500 font-mono">
                          {t("common.buyer")}: {trade.buyer.substring(0, 8)}...
                        </p>
                        {trade.status === "locked" && (
                          <a
                            href={`/chat/${trade.id}?participant=${encodeURIComponent(data?.address ?? "")}`}
                            className="text-sm text-blue-600 hover:text-blue-800 underline"
                            onClick={(e) => {
                              e.preventDefault();
                              window.open(
                                `/chat/${trade.id}?participant=${encodeURIComponent(data?.address ?? "")}`,
                                "_blank",
                                "width=460,height=700"
                              );
                            }}
                          >
                            {t("dashboard.chat")}
                          </a>
                        )}
                      </div>
                      <div className="mt-2 flex items-center text-sm text-gray-500 sm:mt-0">
                        <p>
                          {t("dashboard.amount", { amount: (Number(trade.amount_stroops) / 10000000).toFixed(2) })}
                        </p>
                        <p className="ml-4">
                          {new Date(trade.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
