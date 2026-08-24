/**
 * Provider Yield Portal (#408).
 *
 * React dashboard for the automated liquidity-reserve rebalancing &
 * cross-asset yield-aggregation vaults: live APY history chart, TVL /
 * buffer health per settlement asset, one-tap yield harvest, and the
 * dynamic 20% liquid-buffer slider that retunes the optimizer target.
 *
 * Talks to the public/admin endpoints under /api/v1/yield/*; every visible
 * string flows through i18n so the localization gate stays green.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { YieldVaultConfig } from "@velo/shared";
import { YIELD_VAULT } from "@velo/shared";
import { YieldApyChart } from "../components/YieldApyChart.js";
import { BufferRatioSlider } from "../components/BufferRatioSlider.js";

interface BufferHealth {
  liquidStroops: string;
  targetLiquidStroops: string;
  action: string;
  shortfallStroops: string;
  ratioNowScaled: string;
}

interface VaultView extends YieldVaultConfig {
  exchangeRateScaled: string;
  deployedStroops: string;
  strategyName?: string;
  apyHistoryBps?: number[];
  buffer: BufferHealth;
}

interface PositionView {
  shareBalance: string;
  valueStroops: string;
}

export interface ProviderYieldPortalProps {
  /** API origin; defaults to same-origin relative paths. */
  apiBaseUrl?: string;
  /** Linked provider identity; position panel stays idle when absent. */
  providerId?: string;
  /** Required for the harvest / ratio actions; read-only view without it. */
  adminApiKey?: string;
  pollIntervalMs?: number;
}

function usdc(stroops: string | bigint): string {
  return (Number(BigInt(stroops)) / 1e7).toFixed(2);
}

const SCALE = YIELD_VAULT.EXCHANGE_RATE_SCALE;

export function ProviderYieldPortal({
  apiBaseUrl = "",
  providerId = "",
  adminApiKey,
  pollIntervalMs = 30_000,
}: ProviderYieldPortalProps): React.ReactElement {
  const { t } = useTranslation();
  const [vaults, setVaults] = useState<VaultView[]>([]);
  const [position, setPosition] = useState<PositionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"harvest" | "ratio" | null>(null);
  const [pendingRatios, setPendingRatios] = useState<Record<string, number>>({});

  const requireAdmin = useCallback((): Record<string, string> | null => {
    if (!adminApiKey) {
      setError(t("yieldPortal.adminKeyNeeded"));
      return null;
    }
    return { "x-admin-api-key": adminApiKey };
  }, [adminApiKey, t]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/yield/vaults`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data: VaultView[] };
      setVaults(body.data ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("yieldPortal.loadFailed"));
    }
  }, [apiBaseUrl, t]);

  const loadPosition = useCallback(
    async (vaultId: string): Promise<void> => {
      try {
        const res = await fetch(
          `${apiBaseUrl}/api/v1/yield/vaults/${vaultId}/providers/${encodeURIComponent(providerId)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data: PositionView };
        setPosition(body.data);
      } catch {
        setPosition(null);
      }
    },
    [apiBaseUrl, providerId],
  );

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollIntervalMs);
    return () => clearInterval(timer);
  }, [refresh, pollIntervalMs]);

  const handleHarvest = async (vault: VaultView): Promise<void> => {
    const headers = requireAdmin();
    if (!headers) return;
    try {
      setBusy("harvest");
      // The server-side tick folds accrued strategy APY into TVL (the
      // harvest) and re-runs the buffer optimizer in one atomic pass.
      const res = await fetch(`${apiBaseUrl}/api/v1/yield/vaults/rebalance`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ vaultId: vault.vaultId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ code: `HTTP ${res.status}` }));
        throw new Error(String(body.code));
      }
      setNotice(t("yieldPortal.harvestDone"));
      await refresh();
      await loadPosition(vault.vaultId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("yieldPortal.loadFailed"));
    } finally {
      setBusy(null);
    }
  };

  const handleApplyRatio = async (vault: VaultView): Promise<void> => {
    const headers = requireAdmin();
    if (!headers) return;
    const ratio = pendingRatios[vault.vaultId];
    if (ratio === undefined) return;
    try {
      setBusy("ratio");
      const res = await fetch(`${apiBaseUrl}/api/v1/yield/vaults/config`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          assetAddress: vault.assetAddress,
          liquidBufferRatio: ratio,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ code: `HTTP ${res.status}` }));
        throw new Error(String(body.code));
      }
      setNotice(t("yieldPortal.ratioApplied", { percent: (ratio * 100).toFixed(0) }));
      setPendingRatios((prev) => {
        const next = { ...prev };
        delete next[vault.vaultId];
        return next;
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("yieldPortal.loadFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="provider-yield-portal" style={{ padding: 20, maxWidth: 960, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0 }}>{t("yieldPortal.title")}</h1>
          <p style={{ margin: "4px 0 0", color: "#6b7280" }}>{t("yieldPortal.subtitle")}</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy !== null}>
          {t("yieldPortal.refresh")}
        </button>
      </header>

      {error && (
        <div role="alert" style={{ background: "#f8d7da", color: "#721c24", padding: 12, borderRadius: 4, marginBottom: 16 }}>
          <p style={{ margin: 0 }}>{error}</p>
          <button type="button" onClick={() => setError(null)}>{t("yieldPortal.dismissError")}</button>
        </div>
      )}
      {notice && (
        <div role="status" style={{ background: "#d4edda", color: "#155724", padding: 12, borderRadius: 4, marginBottom: 16 }}>
          <p style={{ margin: 0 }}>{notice}</p>
          <button type="button" onClick={() => setNotice(null)}>{t("yieldPortal.dismissError")}</button>
        </div>
      )}

      {vaults.length === 0 ? (
        <p>{busy === null ? t("yieldPortal.noVaults") : t("yieldPortal.loading")}</p>
      ) : (
        vaults.map((vault) => {
          const pending = pendingRatios[vault.vaultId] ?? vault.liquidBufferRatio;
          const rate = BigInt(vault.exchangeRateScaled || SCALE.toString());
          const apyNow = vault.apyHistoryBps?.[vault.apyHistoryBps.length - 1] ?? 0;
          return (
            <section
              key={vault.vaultId}
              aria-label={t("yieldPortal.vaultSection")}
              style={{ border: "1px solid var(--perforation, #ddd)", borderRadius: 8, padding: 16, marginBottom: 20 }}
            >
              <h2 style={{ marginTop: 0 }}>
                {`${vault.assetAddress.slice(0, 10)}… · ${vault.strategyName ?? ""}`}
              </h2>

              <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12 }}>
                <div><dt>{t("yieldPortal.tvl")}</dt><dd style={{ fontWeight: 700 }}>{`$${usdc(vault.currentTvlStroops)}`}</dd></div>
                <div><dt>{t("yieldPortal.deployed")}</dt><dd>{`$${usdc(vault.deployedStroops)}`}</dd></div>
                <div><dt>{t("yieldPortal.liquidBuffer")}</dt><dd>{`$${usdc(vault.buffer.liquidStroops)}`}</dd></div>
                <div><dt>{t("yieldPortal.apy")}</dt><dd style={{ color: "#16a34a", fontWeight: 700 }}>{`${(apyNow / 100).toFixed(2)}%`}</dd></div>
                <div><dt>{t("yieldPortal.rateLabel")}</dt><dd>{(Number(rate) / Number(SCALE)).toFixed(4)}</dd></div>
              </dl>

              <YieldApyChart
                apyBps={vault.apyHistoryBps ?? []}
                ariaLabel={t("yieldPortal.chartAlt")}
                width={560}
              />

              <div style={{ marginTop: 12 }}>
                <strong>{t("yieldPortal.bufferSliderLabel")}</strong>
                <BufferRatioSlider
                  value={pending}
                  onChange={(next) =>
                    setPendingRatios((prev) => ({ ...prev, [vault.vaultId]: next }))
                  }
                  disabled={busy !== null}
                  ariaLabel={t("yieldPortal.bufferSliderLabel")}
                />
                {pendingRatios[vault.vaultId] !== undefined &&
                  pendingRatios[vault.vaultId] !== vault.liquidBufferRatio && (
                    <button
                      type="button"
                      onClick={() => void handleApplyRatio(vault)}
                      disabled={busy !== null}
                      style={{ marginLeft: 8 }}
                    >
                      {busy === "ratio" ? t("yieldPortal.applying") : t("yieldPortal.applyRatio")}
                    </button>
                  )}
              </div>

              <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => void handleHarvest(vault)}
                  disabled={busy !== null}
                  style={{ fontWeight: 700 }}
                >
                  {busy === "harvest" ? t("yieldPortal.harvesting") : t("yieldPortal.harvest")}
                </button>
                <span style={{ fontSize: ".85rem", color: "#6b7280" }}>
                  {`${t("yieldPortal.bufferAction")}: ${vault.buffer.action}`}
                </span>
              </div>

              <footer style={{ marginTop: 12, borderTop: "1px solid var(--perforation, #eee)", paddingTop: 8 }}>
                {position ? (
                  <span>
                    {`${t("yieldPortal.yourShares")}: ${position.shareBalance} · ${t("yieldPortal.yourValueUsdc")}: $${usdc(position.valueStroops)}`}
                  </span>
                ) : (
                  <button type="button" onClick={() => void loadPosition(vault.vaultId)}>
                    {t("yieldPortal.checkPosition")}
                  </button>
                )}
              </footer>
            </section>
          );
        })
      )}
    </div>
  );
}

export default ProviderYieldPortal;

