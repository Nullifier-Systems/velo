import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { applyDocumentLocale, RTL_LOCALES } from "../i18n/index.js";

// ---------------------------------------------------------------------------
// Locale metadata
// ---------------------------------------------------------------------------

const FLAG_EMOJI: Record<string, string> = {
  en: "🇺🇸",
  es: "🇲🇽",
  fr: "🇫🇷",
  ar: "🇸🇦",
  pt: "🇧🇷",
};

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  ar: "العربية",
  pt: "Português",
};

/** ISO 4217 currency code associated with each locale's primary market. */
const LOCALE_CURRENCY: Record<string, string> = {
  en: "USD",
  es: "MXN",
  fr: "EUR",
  ar: "SAR",
  pt: "BRL",
};

const SUPPORTED_LOCALES = Object.keys(LANGUAGE_NAMES);

// ---------------------------------------------------------------------------
// Currency formatter
// ---------------------------------------------------------------------------

/**
 * Format a USD-denominated amount into the display currency of `locale`.
 *
 * We keep conversion intentionally 1:1 here because Velo stores amounts in
 * USDC; real FX conversion would require a live rate feed that is out of
 * scope for this feature. The formatter only changes the *presentation*
 * (symbol, decimal separator, digit grouping) — not the numeric value.
 *
 * @example
 *   formatCurrency(50, "en")  → "$50.00"
 *   formatCurrency(50, "fr")  → "50,00 €"
 *   formatCurrency(50, "ar")  → "٥٠٫٠٠ ر.س."
 *   formatCurrency(50, "pt")  → "R$ 50,00"
 */
export function formatCurrency(amount: number, locale: string): string {
  const tag = locale.split("-")[0] ?? "en";
  const currency = LOCALE_CURRENCY[tag] ?? "USD";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Graceful fallback if the locale/currency pair is rejected by the runtime.
    return `${currency} ${amount.toFixed(2)}`;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const currentLang = i18n.language?.split("-")[0] ?? "en";
  const isRtl = RTL_LOCALES.has(currentLang);

  // Re-apply dir attribute on mount to cover page-reload hydration.
  useEffect(() => {
    applyDocumentLocale(currentLang);
  }, [currentLang]);

  // Close the dropdown when clicking outside.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const selectLanguage = (lang: string) => {
    i18n.changeLanguage(lang);
    localStorage.setItem("velo-locale", lang);
    setOpen(false);
  };

  return (
    <div
      ref={menuRef}
      className="lang-switcher"
      style={{
        position: "fixed",
        top: "12px",
        // Use logical inset so the button always sits on the trailing edge
        // regardless of the current document direction.
        insetInlineEnd: "12px",
        zIndex: 1000,
      }}
    >
      {/* Trigger button */}
      <button
        className="lang-switcher__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("language.switch")}
        style={{
          background: "rgba(255,255,255,0.15)",
          backdropFilter: "blur(10px)",
          border: "1px solid rgba(255,255,255,0.25)",
          borderRadius: "8px",
          padding: "6px 12px",
          cursor: "pointer",
          fontSize: "14px",
          color: "var(--color-text, inherit)",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          transition: "all 0.2s ease",
        }}
      >
        <span style={{ fontSize: "16px" }} aria-hidden="true">
          {FLAG_EMOJI[currentLang]}
        </span>
        <span>{LANGUAGE_NAMES[currentLang]}</span>
        <span
          aria-hidden="true"
          style={{
            fontSize: "10px",
            opacity: 0.7,
            marginInlineStart: "2px",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease",
          }}
        >
          ▾
        </span>
      </button>

      {/* Dropdown menu */}
      {open && (
        <ul
          role="listbox"
          aria-label={t("language.switch")}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            insetInlineEnd: 0,
            margin: 0,
            padding: "4px 0",
            listStyle: "none",
            background: "rgba(255,255,255,0.95)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(0,0,0,0.1)",
            borderRadius: "10px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            minWidth: "160px",
            zIndex: 1001,
            // Keep the menu on the correct side for RTL.
            direction: isRtl ? "rtl" : "ltr",
          }}
        >
          {SUPPORTED_LOCALES.map((lang) => {
            const isActive = lang === currentLang;
            return (
              <li
                key={lang}
                role="option"
                aria-selected={isActive}
                onClick={() => selectLanguage(lang)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "8px 14px",
                  cursor: "pointer",
                  fontSize: "14px",
                  color: isActive
                    ? "var(--status-released, #1F6B4A)"
                    : "var(--ink-black, #1B2A22)",
                  fontWeight: isActive ? 600 : 400,
                  backgroundColor: isActive
                    ? "rgba(31,107,74,0.08)"
                    : "transparent",
                  transition: "background-color 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.backgroundColor =
                    "rgba(0,0,0,0.05)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.backgroundColor = isActive
                    ? "rgba(31,107,74,0.08)"
                    : "transparent";
                }}
              >
                <span aria-hidden="true" style={{ fontSize: "18px" }}>
                  {FLAG_EMOJI[lang]}
                </span>
                <span>{LANGUAGE_NAMES[lang]}</span>
                {isActive && (
                  <span
                    aria-hidden="true"
                    style={{ marginInlineStart: "auto", fontSize: "12px" }}
                  >
                    ✓
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
