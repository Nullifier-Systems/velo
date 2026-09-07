import en from "../i18n/locales/en.json" with { type: "json" };
import es from "../i18n/locales/es.json" with { type: "json" };
import fr from "../i18n/locales/fr.json" with { type: "json" };
import ar from "../i18n/locales/ar.json" with { type: "json" };
import pt from "../i18n/locales/pt.json" with { type: "json" };

export type Locale = "en" | "es" | "fr" | "ar" | "pt";

const translations: Record<Locale, typeof en> = { en, es, fr, ar, pt };

/**
 * Resolve the best locale from an Accept-Language header.
 * Returns 'en' as default if no supported locale is found.
 */
export function resolveLocale(acceptLanguage: string | undefined): Locale {
  if (!acceptLanguage) return "en";

  const locales = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, qRaw] = part.trim().split(";");
      const quality = qRaw ? parseFloat(qRaw.split("=")[1] ?? "1") : 1;
      return { tag: tag.split("-")[0]?.toLowerCase(), quality };
    })
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of locales) {
    if (tag === "es") return "es";
    if (tag === "fr") return "fr";
    if (tag === "ar") return "ar";
    if (tag === "pt") return "pt";
    if (tag === "en") return "en";
  }
  return "en";
}

/**
 * Get a localized string with optional interpolation.
 * Usage: t("en", "errors.notFound") => "Request not found"
 * Usage: t("ar", "notifications.claimUpdate", { id: "abc", amount: "10.00", status: "released" })
 *
 * Falls back to English when a key is missing in the requested locale.
 */
export function t(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>
): string {
  const keys = key.split(".");
  let value: any = translations[locale] ?? translations.en;

  for (const k of keys) {
    if (value === undefined || value === null) break;
    value = value[k];
  }

  if (typeof value !== "string") {
    // Fallback to English when the key is missing in the requested locale.
    let fallback: any = translations.en;
    for (const k of keys) {
      if (fallback === undefined || fallback === null) break;
      fallback = fallback[k];
    }
    value = fallback;
    if (typeof value !== "string") return key;
  }

  if (params) {
    return value.replace(/\{\{(\w+)\}\}/g, (_, param: string) =>
      String(params[param] ?? `{{${param}}}`)
    );
  }

  return value;
}
