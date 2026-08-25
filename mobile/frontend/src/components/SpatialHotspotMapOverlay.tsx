import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

export interface HotspotFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
  properties: {
    h3Index: string;
    activeRequestsCount: number;
    availableProvidersCount: number;
    demandRatio: number;
    feeMultiplier: number;
    boostPercentage: number;
    color: "green" | "orange" | "red";
    center?: { lat: number; lng: number };
    updatedAt: string;
  };
}

export interface HotspotGeoJSON {
  type: "FeatureCollection";
  features: HotspotFeature[];
  metadata: {
    totalHotspots: number;
    maxMultiplier: number;
    minDemandRatioThreshold: number;
    generatedAt: string;
  };
}

interface Props {
  apiUrl?: string;
  initialData?: HotspotGeoJSON;
  onSelectHotspot?: (hotspot: HotspotFeature) => void;
}

export function getHotspotColor(feeMultiplier: number): "green" | "orange" | "red" {
  if (feeMultiplier > 1.6) return "red";
  if (feeMultiplier > 1.2) return "orange";
  return "green";
}

export default function SpatialHotspotMapOverlay({
  apiUrl = "/api/v1/spatial/hotspots",
  initialData,
  onSelectHotspot,
}: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<HotspotGeoJSON | null>(initialData ?? null);
  const [selectedHotspot, setSelectedHotspot] = useState<HotspotFeature | null>(null);
  const [loading, setLoading] = useState<boolean>(!initialData);
  const [error, setError] = useState<string | null>(null);

  const fetchHotspots = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(apiUrl);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json: HotspotGeoJSON = await res.json();
      setData(json);
      if (json.features.length > 0 && !selectedHotspot) {
        setSelectedHotspot(json.features[0]);
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to load hotspots");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!initialData) {
      fetchHotspots();
    } else if (initialData.features.length > 0 && !selectedHotspot) {
      setSelectedHotspot(initialData.features[0]);
    }
  }, [initialData, apiUrl]);

  const handleSelect = (feature: HotspotFeature) => {
    setSelectedHotspot(feature);
    if (onSelectHotspot) {
      onSelectHotspot(feature);
    }
  };

  const getColorHex = (color: "green" | "orange" | "red") => {
    switch (color) {
      case "red":
        return "#ef4444";
      case "orange":
        return "#f97316";
      case "green":
      default:
        return "#22c55e";
    }
  };

  return (
    <div className="spatial-hotspot-container" data-testid="spatial-hotspot-map">
      <div className="spatial-hotspot-header">
        <div>
          <h2 className="spatial-hotspot-title">{t("hotspots.title")}</h2>
          <p className="spatial-hotspot-subtitle">{t("hotspots.subtitle")}</p>
        </div>
        <button
          className="spatial-hotspot-refresh-btn"
          onClick={fetchHotspots}
          disabled={loading}
          aria-label={t("hotspots.refresh")}
        >
          {loading ? t("hotspots.loading") : t("hotspots.refresh")}
        </button>
      </div>

      {loading && !data && (
        <div className="spatial-hotspot-loading" data-testid="hotspot-loading">
          <p>{t("hotspots.loading")}</p>
        </div>
      )}

      {error && !data && (
        <div className="spatial-hotspot-error" data-testid="hotspot-error">
          <p>{t("common.error")}: {error}</p>
        </div>
      )}

      {data && (
        <div className="spatial-hotspot-content">
          {data.features.length === 0 ? (
            <div className="spatial-hotspot-empty" data-testid="hotspot-empty">
              <p>{t("hotspots.noHotspots")}</p>
            </div>
          ) : (
            <>
              {/* Hex Cell Grid Badges */}
              <div className="spatial-hotspot-grid" role="list" aria-label={t("hotspots.liveDemand")}>
                {data.features.map((feature) => {
                  const isSelected = selectedHotspot?.id === feature.id;
                  const colorHex = getColorHex(feature.properties.color);
                  return (
                    <button
                      key={feature.id}
                      type="button"
                      role="listitem"
                      className={`spatial-hex-card ${isSelected ? "selected" : ""}`}
                      style={{
                        borderColor: isSelected ? colorHex : "transparent",
                        borderLeftColor: colorHex,
                        borderLeftWidth: "4px",
                      }}
                      onClick={() => handleSelect(feature)}
                      data-testid={`hotspot-cell-${feature.id}`}
                    >
                      <div className="spatial-hex-badge" style={{ backgroundColor: colorHex }}>
                        {t("hotspots.multiplierShort", { multiplier: feature.properties.feeMultiplier.toFixed(2) })}
                      </div>
                      <div className="spatial-hex-info">
                        <span className="spatial-hex-id">{feature.properties.h3Index}</span>
                        <span className="spatial-hex-boost">
                          {t("hotspots.boost", { boost: feature.properties.boostPercentage })}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Selected Hotspot Detail Card */}
              {selectedHotspot ? (
                <div
                  className="spatial-hotspot-detail-card"
                  data-testid="selected-hotspot-detail"
                >
                  <div className="spatial-detail-header">
                    <span
                      className="spatial-detail-tag"
                      style={{
                        backgroundColor: getColorHex(selectedHotspot.properties.color),
                      }}
                    >
                      {t("hotspots.multiplier", {
                        multiplier: selectedHotspot.properties.feeMultiplier.toFixed(2),
                      })}
                    </span>
                    <span className="spatial-detail-boost">
                      {t("hotspots.boost", {
                        boost: selectedHotspot.properties.boostPercentage,
                      })}
                    </span>
                  </div>

                  <p className="spatial-detail-prompt">{t("hotspots.relocatePrompt")}</p>

                  <div className="spatial-detail-metrics">
                    <div className="spatial-metric-item">
                      <span className="metric-label">{t("hotspots.demandRatio", { ratio: selectedHotspot.properties.demandRatio.toFixed(2) })}</span>
                    </div>
                    <div className="spatial-metric-item">
                      <span className="metric-label">{t("hotspots.activeRequests", { count: selectedHotspot.properties.activeRequestsCount })}</span>
                    </div>
                    <div className="spatial-metric-item">
                      <span className="metric-label">{t("hotspots.availableProviders", { count: selectedHotspot.properties.availableProvidersCount })}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="spatial-hotspot-hint">
                  <p>{t("hotspots.selectHex")}</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
