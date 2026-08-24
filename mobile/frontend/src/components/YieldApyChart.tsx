/**
 * APY history sparkline for the provider yield portal (#408).
 *
 * Pure inline SVG — no chart dependency exists in this package, so the
 * component renders a polyline + gradient area over normalized points.
 * All display strings arrive as props so the localization validator sees no
 * raw literals here; the page passes t()-translated labels.
 */

import React from "react";

export interface YieldApyChartProps {
  /** APY observations in basis points, oldest → newest. */
  apyBps: number[];
  width?: number;
  height?: number;
  /** Accessible description (translated by the parent). */
  ariaLabel: string;
  /** Formatters translated by the parent, e.g. `4.2%` / `600 bps`. */
  formatBps?: (bps: number) => string;
}

export function YieldApyChart({
  apyBps,
  width = 320,
  height = 96,
  ariaLabel,
  formatBps = (bps) => `${(bps / 100).toFixed(1)}%`,
}: YieldApyChartProps): React.ReactElement {
  if (apyBps.length === 0) {
    return <svg role="img" aria-label={ariaLabel} width={width} height={height} />;
  }

  const min = Math.min(...apyBps);
  const max = Math.max(...apyBps);
  const span = max > min ? max - min : 1;
  const pad = 6;

  const pointAt = (value: number, index: number): string => {
    const x =
      apyBps.length === 1
        ? width / 2
        : pad + (index * (width - 2 * pad)) / (apyBps.length - 1);
    const y = height - pad - ((value - min) / span) * (height - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };

  const linePoints = apyBps.map(pointAt).join(" ");
  const areaPoints = [
    `${pad},${height - pad}`,
    ...apyBps.map(pointAt),
    `${width - pad},${height - pad}`,
  ].join(" ");

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ maxWidth: "100%" }}
    >
      <defs>
        <linearGradient id="yield-apy-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill="url(#yield-apy-fill)" />
      <polyline
        points={linePoints}
        fill="none"
        stroke="#16a34a"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <text x={pad} y={12} fontSize="10" fill="#6b7280">
        {formatBps(max)}
      </text>
      <text x={pad} y={height - 2} fontSize="10" fill="#6b7280">
        {formatBps(min)}
      </text>
      <circle
        cx={width - pad}
        cy={
          height -
          pad -
          ((apyBps[apyBps.length - 1] - min) / span) * (height - 2 * pad)
        }
        r="3"
        fill="#16a34a"
      />
    </svg>
  );
}

export default YieldApyChart;
