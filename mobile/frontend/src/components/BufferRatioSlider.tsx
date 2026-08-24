/**
 * Controlled slider for tuning a vault's dynamic liquid-buffer ratio (#408).
 *
 * The value is a fraction (0..1); bounds default to the shared YIELD_VAULT
 * constants so the UI can never propose a ratio the optimizer would clamp.
 * All display strings arrive as props/translations from the parent page.
 */

import React from "react";
import { YIELD_VAULT } from "@velo/shared";

export interface BufferRatioSliderProps {
  value: number;
  onChange: (next: number) => void;
  onCommit?: () => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Translated accessible label (attribute is flagged when literal). */
  ariaLabel: string;
}

export function BufferRatioSlider({
  value,
  onChange,
  onCommit,
  min = YIELD_VAULT.MIN_LIQUID_BUFFER_RATIO,
  max = YIELD_VAULT.MAX_LIQUID_BUFFER_RATIO,
  step = 0.01,
  disabled = false,
  ariaLabel,
}: BufferRatioSliderProps): React.ReactElement {
  const clamped = Math.min(max, Math.max(min, value));
  const percent = ((clamped - min) / (max - min)) * 100;

  return (
    <div className="buffer-ratio-slider" style={{ width: "100%" }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={clamped}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(Number(event.target.value))}
        onMouseUp={onCommit}
        onTouchEnd={onCommit}
        onKeyUp={onCommit}
        style={{ width: "100%", accentColor: "#16a34a" }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: ".8rem",
          color: "var(--ink-black, #111)",
        }}
      >
        <span>{`${Math.round(min * 100)}%`}</span>
        <output
          style={{
            fontWeight: 700,
            background: `linear-gradient(90deg, #bbf7d0 ${percent.toFixed(0)}%, transparent ${percent.toFixed(0)}%)`,
            padding: "0 .5rem",
          }}
        >
          {`${(clamped * 100).toFixed(0)}%`}
        </output>
        <span>{`${Math.round(max * 100)}%`}</span>
      </div>
    </div>
  );
}

export default BufferRatioSlider;
