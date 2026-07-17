import { useState } from "react";
import { useLanguage, translations } from "../lib/lang";
import LanguageToggle from "../components/LanguageToggle";

export default function Home() {
  const [shouldCrash, setShouldCrash] = useState(false);
  const { lang } = useLanguage();
  const t = translations[lang];

  if (shouldCrash) {
    throw new Error("Simulated component crash");
  }

  return (
    <main className="home-container">
      <LanguageToggle />
      <div className="home-card">
        <h1 className="home-title">Velo</h1>
        <p className="home-subtitle">{t.homeSubtitle}</p>
        {/* TODO (Core Retail Flow P0): one identity per device, real
            nearby-provider list from the backend, real wallet balance. */}
        <div className="home-placeholder">
          <p>{t.homePlaceholder}</p>
          <button 
            className="home-crash-button"
            onClick={() => setShouldCrash(true)}
          >
            {t.homeCrashButton}
          </button>
        </div>
      </div>
    </main>
  );
}


