// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "../../i18n/index.js"; // initialise i18n singleton (same pattern as all other tests)
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import i18n from "../../i18n/index.js";
import LanguageSwitcher from "../LanguageSwitcher.js";

/**
 * UI layout tests for LanguageSwitcher — issue #435
 *
 * Covers:
 *  1. Trigger button renders with accessible label
 *  2. All 5 language options appear when opened
 *  3. Arabic selection sets document dir to "rtl"
 *  4. LTR locale selection resets dir to "ltr"
 *  5. aria-selected marks the active option
 *  6. Dropdown closes after selection
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSwitcher() {
  // No Provider needed — the i18n singleton is imported above and shared
  return render(<LanguageSwitcher />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LanguageSwitcher", () => {
  const originalDir  = document.documentElement.dir;
  const originalLang = document.documentElement.lang;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    document.documentElement.dir  = "ltr";
    document.documentElement.lang = "en";
  });

  afterEach(() => {
    cleanup();
    document.documentElement.dir  = originalDir;
    document.documentElement.lang = originalLang;
  });

  // -------------------------------------------------------------------------
  // 1. Trigger button renders
  // -------------------------------------------------------------------------

  it("renders the trigger button", () => {
    renderSwitcher();
    // The button has aria-haspopup so it's queryable by role
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("trigger starts with aria-expanded=false", () => {
    renderSwitcher();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  // -------------------------------------------------------------------------
  // 2. Dropdown renders all 5 locales
  // -------------------------------------------------------------------------

  it("shows all 5 language options when the trigger is clicked", async () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => screen.getByRole("listbox"));

    expect(screen.getByText("English")).toBeInTheDocument();
    expect(screen.getByText("Español")).toBeInTheDocument();
    expect(screen.getByText("Français")).toBeInTheDocument();
    expect(screen.getByText("العربية")).toBeInTheDocument();
    expect(screen.getByText("Português")).toBeInTheDocument();
  });

  it("marks the trigger as aria-expanded=true when open", async () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true")
    );
  });

  // -------------------------------------------------------------------------
  // 3. Arabic → dir="rtl"
  // -------------------------------------------------------------------------

  it("sets document.dir to 'rtl' when Arabic is selected", async () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => screen.getByRole("listbox"));

    fireEvent.click(screen.getByText("العربية"));
    await waitFor(() =>
      expect(document.documentElement.dir).toBe("rtl")
    );
    expect(document.documentElement.lang).toBe("ar");
  });

  // -------------------------------------------------------------------------
  // 4. LTR locale → dir="ltr"
  // -------------------------------------------------------------------------

  it("resets document.dir to 'ltr' when switching from Arabic to English", async () => {
    await i18n.changeLanguage("ar");
    renderSwitcher();

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => screen.getByRole("listbox"));

    fireEvent.click(screen.getByText("English"));
    await waitFor(() =>
      expect(document.documentElement.dir).toBe("ltr")
    );
    expect(document.documentElement.lang).toBe("en");
  });

  it("keeps dir='ltr' when French is selected", async () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => screen.getByRole("listbox"));

    fireEvent.click(screen.getByText("Français"));
    await waitFor(() =>
      expect(document.documentElement.dir).toBe("ltr")
    );
  });

  // -------------------------------------------------------------------------
  // 5. aria-selected on the active option
  // -------------------------------------------------------------------------

  it("marks the active language option as aria-selected", async () => {
    await i18n.changeLanguage("fr");
    renderSwitcher();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => screen.getByRole("listbox"));

    const options = screen.getAllByRole("option");
    const frOption = options.find((o) => o.textContent?.includes("Français"));
    expect(frOption).toBeDefined();
    expect(frOption!.getAttribute("aria-selected")).toBe("true");
  });

  // -------------------------------------------------------------------------
  // 6. Dropdown closes after selection
  // -------------------------------------------------------------------------

  it("closes the dropdown after a language is selected", async () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => screen.getByRole("listbox"));

    fireEvent.click(screen.getByText("Español"));
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    );
  });
});
