/**
 * UI layout tests for LanguageSwitcher — issue #435
 *
 * Covers:
 *  1. All 5 language options are rendered in the dropdown.
 *  2. Selecting Arabic switches document dir to "rtl".
 *  3. Selecting English switches document dir to "ltr".
 *  4. Active language is visually indicated (aria-selected).
 *  5. Dropdown is accessible (role=listbox, aria-expanded).
 */

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import i18n from "../../i18n/index.js";
import LanguageSwitcher from "../LanguageSwitcher.js";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

const changeLanguage = (lng: string): Promise<void> =>
  act(() => new Promise<void>((resolve) => i18n.changeLanguage(lng, () => resolve())));

function renderSwitcher() {
  return render(
    <I18nextProvider i18n={i18n}>
      <LanguageSwitcher />
    </I18nextProvider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LanguageSwitcher", () => {
  const originalDir  = document.documentElement.dir;
  const originalLang = document.documentElement.lang;

  beforeEach(async () => {
    await changeLanguage("en");
  });

  afterEach(() => {
    document.documentElement.dir  = originalDir;
    document.documentElement.lang = originalLang;
  });

  // -------------------------------------------------------------------------
  // 1. Trigger button renders
  // -------------------------------------------------------------------------

  it("renders the trigger button with an accessible label", () => {
    renderSwitcher();
    const btn = screen.getByRole("button", { name: /switch language/i });
    expect(btn).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 2. Dropdown renders all 5 locales
  // -------------------------------------------------------------------------

  it("shows all 5 language options when opened", async () => {
    renderSwitcher();
    const trigger = screen.getByRole("button", { name: /switch language/i });
    await act(() => fireEvent.click(trigger));

    // All five names must appear in the dropdown.
    expect(screen.getByText("English")).toBeTruthy();
    expect(screen.getByText("Español")).toBeTruthy();
    expect(screen.getByText("Français")).toBeTruthy();
    expect(screen.getByText("العربية")).toBeTruthy();
    expect(screen.getByText("Português")).toBeTruthy();
  });

  it("renders a listbox with role=listbox when open", async () => {
    renderSwitcher();
    const trigger = screen.getByRole("button");
    await act(() => fireEvent.click(trigger));
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("marks the trigger as aria-expanded=true when open", async () => {
    renderSwitcher();
    const trigger = screen.getByRole("button", { name: /switch language/i });
    await act(() => fireEvent.click(trigger));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  // -------------------------------------------------------------------------
  // 3. Selecting Arabic → dir="rtl"
  // -------------------------------------------------------------------------

  it("sets document.dir to 'rtl' when Arabic is selected", async () => {
    renderSwitcher();
    const trigger = screen.getByRole("button", { name: /switch language/i });
    await act(() => fireEvent.click(trigger));

    const arabicOption = screen.getByText("العربية");
    await act(() => fireEvent.click(arabicOption));

    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
  });

  // -------------------------------------------------------------------------
  // 4. Selecting LTR locale → dir="ltr"
  // -------------------------------------------------------------------------

  it("resets document.dir to 'ltr' when switching from Arabic to English", async () => {
    // First switch to Arabic.
    await changeLanguage("ar");
    expect(document.documentElement.dir).toBe("rtl");

    renderSwitcher();
    const trigger = screen.getByRole("button", { name: /switch language/i });
    await act(() => fireEvent.click(trigger));

    const englishOption = screen.getByText("English");
    await act(() => fireEvent.click(englishOption));

    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
  });

  it("keeps dir='ltr' for French", async () => {
    renderSwitcher();
    const trigger = screen.getByRole("button", { name: /switch language/i });
    await act(() => fireEvent.click(trigger));

    await act(() => fireEvent.click(screen.getByText("Français")));
    expect(document.documentElement.dir).toBe("ltr");
  });

  // -------------------------------------------------------------------------
  // 5. aria-selected on the active option
  // -------------------------------------------------------------------------

  it("marks the current language option as aria-selected", async () => {
    await changeLanguage("fr");
    renderSwitcher();

    const trigger = screen.getByRole("button", { name: /switch language/i });
    await act(() => fireEvent.click(trigger));

    const options = screen.getAllByRole("option");
    const frOption = options.find((o) => o.textContent?.includes("Français"));
    expect(frOption?.getAttribute("aria-selected")).toBe("true");
  });

  // -------------------------------------------------------------------------
  // 6. Dropdown closes after selection
  // -------------------------------------------------------------------------

  it("closes the dropdown after a language is selected", async () => {
    renderSwitcher();
    const trigger = screen.getByRole("button", { name: /switch language/i });
    await act(() => fireEvent.click(trigger));
    expect(screen.getByRole("listbox")).toBeTruthy();

    await act(() => fireEvent.click(screen.getByText("Español")));
    // Listbox should no longer be visible.
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
