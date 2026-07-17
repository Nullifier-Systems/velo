import { useLanguage } from "../lib/lang";

export default function LanguageToggle() {
  const { lang, toggleLanguage } = useLanguage();

  return (
    <div className="lang-toggle-container">
      <button
        className={`lang-toggle-btn ${lang === "en" ? "lang-toggle-btn--active" : ""}`}
        onClick={() => lang !== "en" && toggleLanguage()}
      >
        EN
      </button>
      <span className="lang-toggle-separator">|</span>
      <button
        className={`lang-toggle-btn ${lang === "es" ? "lang-toggle-btn--active" : ""}`}
        onClick={() => lang !== "es" && toggleLanguage()}
      >
        ES
      </button>
    </div>
  );
}
