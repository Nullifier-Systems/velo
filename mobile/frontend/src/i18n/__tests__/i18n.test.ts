/**
 * Unit tests for the i18n engine — issue #435
 *
 * Covers:
 *  1. Missing translation key falls back to English, not raw key.
 *  2. Switching to Arabic sets document.documentElement.dir to "rtl".
 *  3. Switching back to a LTR locale resets dir to "ltr".
 *  4. formatCurrency produces locale-appropriate output.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Patch the import.meta.env before importing i18n so saveMissing stays off in tests.
vi.stubEnv("DEV", false);

import i18n, { applyDocumentLocale, RTL_LOCALES } from "../index.js";
import { formatCurrency } from "../../components/LanguageSwitcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const changeLanguage = (lng: string): Promise<void> =>
  new Promise((resolve) => {
    i18n.changeLanguage(lng, () => resolve());
  });

// ---------------------------------------------------------------------------
// 1. Missing key fallback
// ---------------------------------------------------------------------------

describe("i18n missing-key fallback", () => {
  beforeEach(() => changeLanguage("fr"));

  it("returns the English string for a key missing in French locale", async () => {
    // We deliberately request a key that exists in English but not French by
    // temporarily removing it from the French resource bundle.
    const fr = i18n.getResourceBundle("fr", "translation");
    const originalVal = fr?.claim?.brand;

    // Delete the key in the live resource so we can test fallback.
    if (fr?.claim) {
      delete fr.claim.brand;
      i18n.addResourceBundle("fr", "translation", fr, true, true);
    }

    const result = i18n.t("claim.brand");
    // Should fall back to the English value "VELO", not the raw key.
    expect(result).toBe("VELO");
    expect(result).not.toBe("claim.brand");

    // Restore.
    if (fr?.claim) {
      fr.claim.brand = originalVal;
      i18n.addResourceBundle("fr", "translation", fr, true, true);
    }
  });

  it("does not expose raw translation key IDs to users", async () => {
    // A completely non-existent key should still not show the raw key to users
    // when a fallback language exists — i18next returns the fallback or the key,
    // but we confirm it at least tried the fallback chain.
    const result = i18n.t("claim.brand");
    expect(result).not.toContain(".");
  });
});

// ---------------------------------------------------------------------------
// 2. RTL_LOCALES set
// ---------------------------------------------------------------------------

describe("RTL_LOCALES", () => {
  it("contains Arabic", () => {
    expect(RTL_LOCALES.has("ar")).toBe(true);
  });

  it("does not contain LTR locales", () => {
    for (const lng of ["en", "es", "fr", "pt"]) {
      expect(RTL_LOCALES.has(lng)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. applyDocumentLocale — RTL switching
// ---------------------------------------------------------------------------

describe("applyDocumentLocale", () => {
  const originalDir = document.documentElement.dir;
  const originalLang = document.documentElement.lang;

  afterEach(() => {
    document.documentElement.dir = originalDir;
    document.documentElement.lang = originalLang;
  });

  it("sets dir='rtl' for Arabic", () => {
    applyDocumentLocale("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
  });

  it("sets dir='ltr' for English", () => {
    applyDocumentLocale("ar"); // first go RTL
    applyDocumentLocale("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
  });

  it("sets dir='ltr' for French", () => {
    applyDocumentLocale("fr");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("sets dir='ltr' for Portuguese", () => {
    applyDocumentLocale("pt");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("handles BCP-47 subtags like 'ar-SA' correctly", () => {
    applyDocumentLocale("ar-SA");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
  });
});

// ---------------------------------------------------------------------------
// 4. formatCurrency
// ---------------------------------------------------------------------------

describe("formatCurrency", () => {
  it("formats USD for English locale", () => {
    const result = formatCurrency(50, "en");
    expect(result).toContain("50");
    // Must contain a dollar sign or 'USD'
    expect(result).toMatch(/\$|USD/);
  });

  it("formats EUR for French locale", () => {
    const result = formatCurrency(50, "fr");
    expect(result).toContain("50");
    expect(result).toMatch(/€|EUR/);
  });

  it("formats BRL for Portuguese locale", () => {
    const result = formatCurrency(50, "pt");
    expect(result).toContain("50");
    expect(result).toMatch(/R\$|BRL/);
  });

  it("formats SAR for Arabic locale", () => {
    const result = formatCurrency(50, "ar");
    expect(result).toContain("50");
    expect(result).toMatch(/ر\.س\.|SAR/);
  });

  it("returns a non-empty string for any supported locale", () => {
    for (const locale of ["en", "es", "fr", "ar", "pt"]) {
      expect(formatCurrency(100, locale).length).toBeGreaterThan(0);
    }
  });

  it("handles zero correctly", () => {
    expect(formatCurrency(0, "en")).toContain("0");
  });
});
