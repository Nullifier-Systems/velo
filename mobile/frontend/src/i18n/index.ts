import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ar from "./locales/ar.json";
import pt from "./locales/pt.json";

const STORAGE_KEY = "velo-locale";

/** Languages that require right-to-left document layout. */
export const RTL_LOCALES = new Set(["ar"]);

/**
 * Apply document-level dir and lang attributes for the active locale.
 * Called on initialisation and on every language change.
 */
export function applyDocumentLocale(lng: string): void {
  const tag = lng.split("-")[0] ?? "en";
  document.documentElement.lang = tag;
  document.documentElement.dir = RTL_LOCALES.has(tag) ? "rtl" : "ltr";
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
      fr: { translation: fr },
      ar: { translation: ar },
      pt: { translation: pt },
    },
    fallbackLng: "en",
    supportedLngs: ["en", "es", "fr", "ar", "pt"],
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      // Order of detection: URL param > localStorage > browser navigator > fallback
      order: ["querystring", "localStorage", "navigator"],
      lookupQuerystring: "lang",
      lookupLocalStorage: STORAGE_KEY,
      caches: ["localStorage"],
    },
    // In development, log missing translation keys to the console so they can
    // be caught early. The fallbackLng chain silently serves English for users.
    saveMissing: import.meta.env.DEV,
    missingKeyHandler: import.meta.env.DEV
      ? (lngs, ns, key) => {
          console.warn(
            `[i18n] Missing translation key "${key}" for locale(s): ${lngs.join(", ")}. Falling back to English.`
          );
        }
      : undefined,
  });

// Apply dir/lang immediately after init so SSR-hydrated HTML is correct.
i18n.on("initialized", () => applyDocumentLocale(i18n.language));
i18n.on("languageChanged", applyDocumentLocale);

export default i18n;
