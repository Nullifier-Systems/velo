import { useState } from "react";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "../components/LanguageSwitcher.js";

export default function Home() {
  const { t } = useTranslation();
  const [shouldCrash, setShouldCrash] = useState(false);

  if (shouldCrash) {
    throw new Error("Simulated component crash");
  }

  return (
    <main className="home-container">
      <LanguageSwitcher />
      <div className="home-card">
        <h1 className="home-title">{t("app.title")}</h1>
        <p className="home-subtitle">{t("app.subtitle")}</p>
        {/* TODO (Core Retail Flow P0): one identity per device, real
            nearby-provider list from the backend, real wallet balance. */}
        <div className="home-placeholder">
          <p>{t("app.scanPrompt")}</p>
          <button 
            className="home-crash-button"
            onClick={() => setShouldCrash(true)}
          >
            {t("nav.simulateCrash")}
          </button>
        </div>
      </div>
    </main>
  );
}
