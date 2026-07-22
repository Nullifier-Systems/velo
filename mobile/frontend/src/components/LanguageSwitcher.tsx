import React from "react";
import { useTranslation } from "react-i18next";

const FLAG_EMOJI: Record<string, string> = {
  en: "🇺🇸",
  es: "🇲🇽",
};

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Español",
};

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();

  const currentLang = i18n.language?.split("-")[0] ?? "en";

  const toggleLanguage = () => {
    const nextLang = currentLang === "en" ? "es" : "en";
    i18n.changeLanguage(nextLang);
    localStorage.setItem("velo-locale", nextLang);
  };

  return (
    <button
      className="lang-switcher"
      onClick={toggleLanguage}
      aria-label={`Switch language (currently ${LANGUAGE_NAMES[currentLang]})`}
      title={`Switch to ${currentLang === "en" ? "Español" : "English"}`}
      style={{
        position: "fixed",
        top: "12px",
        right: "12px",
        zIndex: 1000,
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
      <span style={{ fontSize: "16px" }}>{FLAG_EMOJI[currentLang]}</span>
      <span>{LANGUAGE_NAMES[currentLang]}</span>
    </button>
  );
}
