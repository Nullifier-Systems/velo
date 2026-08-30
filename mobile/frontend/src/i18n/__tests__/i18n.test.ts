// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, afterEach } from "vitest";
import { applyDocumentLocale, RTL_LOCALES } from "../index.js";
import { formatCurrency } from "../../components/LanguageSwitcher.js";
import "../index.js"; // initialise i18n singleton

/**
 * Unit tests for the i18n engine — issue #435
 *
 * Covers:
 *  1. RTL_LOCALES set contents
 *  2. applyDocumentLocale sets dir/lang correctly for every locale
 *  3. formatCurrency produces locale-appropriate output
 */

// ---------------------------------------------------------------------------
// 1. RTL_LOCALES set
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
// 2. applyDocumentLocale — RTL / LTR switching
// ---------------------------------------------------------------------------

describe("applyDocumentLocale", () => {
  const originalDir  = document.documentElement.dir;
  const originalLang = document.documentElement.lang;

  afterEach(() => {
    document.documentElement.dir  = originalDir;
    document.documentElement.lang = originalLang;
  });

  it("sets dir='rtl' and lang='ar' for Arabic", () => {
    applyDocumentLocale("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
  });

  it("sets dir='ltr' and lang='en' for English", () => {
    applyDocumentLocale("ar"); // switch to RTL first
    applyDocumentLocale("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
  });

  it("sets dir='ltr' for French", () => {
    applyDocumentLocale("fr");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("fr");
  });

  it("sets dir='ltr' for Spanish", () => {
    applyDocumentLocale("es");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("sets dir='ltr' for Portuguese", () => {
    applyDocumentLocale("pt");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("handles BCP-47 subtag 'ar-SA' correctly", () => {
    applyDocumentLocale("ar-SA");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
  });
});

// ---------------------------------------------------------------------------
// 3. formatCurrency — locale-appropriate output
// ---------------------------------------------------------------------------

describe("formatCurrency", () => {
  it("formats USD for English locale", () => {
    const result = formatCurrency(50, "en");
    expect(result).toMatch(/\$|USD/);
    expect(result).toContain("50");
  });

  it("formats EUR for French locale", () => {
    const result = formatCurrency(50, "fr");
    expect(result).toMatch(/€|EUR/);
    expect(result).toContain("50");
  });

  it("formats BRL for Portuguese locale", () => {
    const result = formatCurrency(50, "pt");
    expect(result).toMatch(/R\$|BRL/);
    expect(result).toContain("50");
  });

  it("formats SAR for Arabic locale", () => {
    const result = formatCurrency(50, "ar");
    // SAR symbol varies by runtime; just assert a non-empty string containing the digits
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/50|٥٠/);
  });

  it("returns a non-empty string for every supported locale", () => {
    for (const locale of ["en", "es", "fr", "ar", "pt"]) {
      expect(formatCurrency(100, locale).length).toBeGreaterThan(0);
    }
  });

  it("handles zero without throwing", () => {
    const result = formatCurrency(0, "en");
    expect(result).toContain("0");
  });
});
