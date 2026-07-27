// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminDashboard from "./AdminDashboard.js";

const fraudTrade = {
  id: "trade-fraud",
  seller_address: "seller",
  buyer_address: "buyer",
  status: "locked",
  is_suspicious: true,
  suspicion_notes: "Identity mismatch",
  flagged_at: "2026-02-02T00:00:00.000Z",
  created_at: "2026-02-01T00:00:00.000Z",
};

const ignoredTrade = {
  ...fraudTrade,
  id: "trade-clean",
  is_suspicious: false,
};

const mediumViolation = {
  id: "violation-medium",
  identifier: "198.51.100.4",
  route: "/api/v1/cash/request",
  method: "POST",
  occurred_at: "2026-02-03T00:00:00.000Z",
  offense_count: 4,
  severity: "medium",
  status: "open",
  resolved_at: null,
  resolved_by: null,
};

const highViolation = {
  ...mediumViolation,
  id: "violation-high",
  route: "/api/v1/services",
  occurred_at: "2026-02-01T00:00:00.000Z",
  offense_count: 12,
  severity: "high",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(options: { action401?: boolean } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/admin/status")) return jsonResponse({ ok: true });
    if (url.endsWith("/api/v1/admin/trades") && !init?.method) {
      return jsonResponse({ data: [fraudTrade, ignoredTrade] });
    }
    if (url.endsWith("/api/v1/admin/rate-limit-violations") && !init?.method) {
      return jsonResponse({ data: [mediumViolation, highViolation] });
    }
    if (options.action401) return jsonResponse({ error: "Unauthorized" }, 401);
    if (url.endsWith("/trades/trade-fraud/flag")) {
      return jsonResponse({ data: { id: "trade-fraud", is_suspicious: false } });
    }
    if (url.endsWith("/rate-limit-violations/violation-medium/resolve")) {
      return jsonResponse({
        data: { ...mediumViolation, status: "resolved", resolved_by: "System Admin" },
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
}

async function authenticate() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Admin API key"), "valid-key");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("list", { name: "Unified abuse feed" });
  return user;
}

describe("AdminDashboard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders only the login gate and makes no feed requests before authentication", () => {
    render(<AdminDashboard />);

    expect(screen.getByRole("main", { name: "Admin login" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Unified abuse feed" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates first, then renders a combined feed with suspicious trades only", async () => {
    const fetchMock = installFetch();
    render(<AdminDashboard />);
    await authenticate();

    expect(screen.getByText("trade-fraud", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("POST /api/v1/cash/request")).toBeInTheDocument();
    expect(screen.queryByText("trade-clean")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      "/api/v1/admin/status",
      "/api/v1/admin/trades",
      "/api/v1/admin/rate-limit-violations",
    ]);
  });

  it("sorts mixed item types by recency and severity", async () => {
    installFetch();
    render(<AdminDashboard />);
    const user = await authenticate();

    const itemText = () => screen.getAllByTestId("feed-item").map(item => item.textContent);
    expect(itemText()[0]).toContain("/api/v1/cash/request");
    expect(itemText()[1]).toContain("trade-fraud");
    expect(itemText()[2]).toContain("/api/v1/services");

    await user.selectOptions(screen.getByLabelText("Sort by"), "severity");
    expect(itemText()[0]).toContain("trade-fraud");
    expect(itemText()[1]).toContain("/api/v1/services");
    expect(itemText()[2]).toContain("/api/v1/cash/request");
  });

  it("dismisses fraud and resolves a violation from the unified feed", async () => {
    const fetchMock = installFetch();
    render(<AdminDashboard />);
    const user = await authenticate();

    await user.click(screen.getByRole("button", { name: "Dismiss fraud flag" }));
    await waitFor(() => expect(screen.queryByText("trade-fraud")).not.toBeInTheDocument());

    const mediumItem = screen.getAllByTestId("feed-item").find(item =>
      item.textContent?.includes("/api/v1/cash/request"),
    );
    expect(mediumItem).toBeDefined();
    await user.click(within(mediumItem!).getByRole("button", { name: "Resolve violation" }));
    expect(await within(mediumItem!).findByRole("button", { name: "Resolved" })).toBeDisabled();

    const actionCalls = fetchMock.mock.calls.filter(call => call[1]?.method === "POST");
    expect(String(actionCalls[0][0])).toContain("/trades/trade-fraud/flag");
    expect(actionCalls[0][1]?.body).toBe(JSON.stringify({ suspicious: false }));
    expect(String(actionCalls[1][0])).toContain("/rate-limit-violations/violation-medium/resolve");
  });

  it("clears authenticated state and feed when a request returns 401", async () => {
    installFetch({ action401: true });
    render(<AdminDashboard />);
    const user = await authenticate();

    await user.click(screen.getByRole("button", { name: "Dismiss fraud flag" }));

    expect(await screen.findByRole("main", { name: "Admin login" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Unified abuse feed" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Admin API key")).toHaveValue("");
  });
});
