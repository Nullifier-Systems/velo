// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "../i18n/index.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminCircuitBreakerDashboard, {
  validateContractId,
} from "./AdminCircuitBreakerDashboard.js";

const CONTRACT = "C".padEnd(56, "a");

const stateFixture = {
  contractId: CONTRACT,
  totalLockedStroops: "1000000",
  totalAllocatedStroops: "0",
  feeAccumulatorStroops: "0",
  lastProcessedLedger: 49281901,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(options: { status?: "HALTED" | "HEALTHY"; override401?: boolean } = {}) {
  const status = options.status ?? "HEALTHY";
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/admin/status")) return jsonResponse({ ok: true });
    if (url.includes("/api/v1/admin/circuit-breaker/state")) {
      return jsonResponse({ status: "success", data: { ...stateFixture, status } });
    }
    if (url.includes("/api/v1/admin/circuit-breaker/incidents")) {
      return jsonResponse({
        status: "success",
        data: [
          {
            incidentId: "inc-1",
            contractId: CONTRACT,
            violatedInvariant: "INV-07_RESERVE_CONSERVATION",
            actionTaken: "PAUSE_SINGLE_ESCROW",
            txPauseHash: "tx-pause-1",
          },
        ],
      });
    }
    if (url.endsWith("/api/v1/admin/circuit-breaker/override")) {
      if (options.override401) return jsonResponse({ error: "Unauthorized" }, 401);
      return jsonResponse({
        status: "success",
        contractId: CONTRACT,
        action: "FORCE_PAUSE",
        newStatus: "HALTED",
        txHash: "tx-override-1",
        incidentId: "inc-2",
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
}

async function authenticate() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Admin API key"), "valid-key");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Contract ID");
  return user;
}

async function attachContract(user: Awaited<ReturnType<typeof userEvent.setup>>) {
  await user.type(screen.getByLabelText("Contract ID"), CONTRACT);
  await user.tab();
  await screen.findByTestId("cb-status");
}

describe("AdminCircuitBreakerDashboard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exposes contract id validation as a pure helper", () => {
    expect(validateContractId(CONTRACT)).toBe(true);
    expect(validateContractId("C-too-short")).toBe(false);
    expect(validateContractId("")).toBe(false);
  });

  it("gates on admin auth before any circuit-breaker request", () => {
    render(<AdminCircuitBreakerDashboard />);
    expect(screen.getByRole("main", { name: "Admin login" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows a validation error when the contract id is not 56 chars on blur", async () => {
    installFetch();
    render(<AdminCircuitBreakerDashboard />);
    const user = await authenticate();

    await user.type(screen.getByLabelText("Contract ID"), "C-short");
    await user.tab();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Contract ID must be 56 characters.",
    );
    expect(screen.queryByTestId("cb-status")).not.toBeInTheDocument();
  });

  it("loads and renders state and incidents for a valid contract", async () => {
    installFetch();
    render(<AdminCircuitBreakerDashboard />);
    const user = await authenticate();
    await attachContract(user);

    expect(screen.getByTestId("cb-status")).toHaveTextContent("HEALTHY");
    expect(screen.getByText("1000000")).toBeInTheDocument();
    expect(screen.getByText("INV-07_RESERVE_CONSERVATION")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Force pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Unpause" })).toBeDisabled();
  });

  it("confirms a pause via the modal and broadcasts the override", async () => {
    const fetchMock = installFetch();
    render(<AdminCircuitBreakerDashboard />);
    const user = await authenticate();
    await attachContract(user);

    await user.click(screen.getByRole("button", { name: "Force pause" }));
    expect(
      screen.getByRole("dialog", { name: "Confirm circuit-breaker override" }),
    ).toBeInTheDocument();

    const confirm = screen.getByRole("button", { name: "Confirm pause" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText("Override reason"), "confirmed drift");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(await screen.findByText("tx-override-1")).toBeInTheDocument();
    const overrideCall = fetchMock.mock.calls.find(call =>
      String(call[0]).endsWith("/admin/circuit-breaker/override"),
    );
    expect(overrideCall).toBeDefined();
    expect(overrideCall![1]?.body).toBe(
      JSON.stringify({ contractId: CONTRACT, action: "FORCE_PAUSE", reason: "confirmed drift" }),
    );
  });

  it("flashes the HALTED banner when the contract is halted", async () => {
    installFetch({ status: "HALTED" });
    render(<AdminCircuitBreakerDashboard />);
    const user = await authenticate();
    await attachContract(user);

    const status = screen.getByTestId("cb-status");
    expect(status).toHaveClass("cb-status-halted");
    expect(status).toHaveTextContent("HALTED");
    expect(screen.getByRole("button", { name: "Force pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unpause" })).toBeEnabled();
  });

  it("recovers a disconnected ledger stream via Reconnect Stream", async () => {
    let streamState = "disconnected" as "connected" | "disconnected";
    const stream = {
      getStatus: () => streamState,
      reconnect: () => {
        streamState = "connected";
      },
    };
    installFetch();
    render(<AdminCircuitBreakerDashboard stream={stream} />);
    const user = await authenticate();

    expect(await screen.findByRole("alert")).toHaveTextContent("Ledger stream is disconnected");

    await user.click(screen.getByRole("button", { name: "Reconnect Stream" }));
    expect(streamState).toBe("connected");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("logs out when a request returns 401", async () => {
    installFetch({ override401: true });
    render(<AdminCircuitBreakerDashboard />);
    const user = await authenticate();
    await attachContract(user);

    await user.click(screen.getByRole("button", { name: "Force pause" }));
    await user.type(screen.getByLabelText("Override reason"), "confirmed drift");
    await user.click(screen.getByRole("button", { name: "Confirm pause" }));

    expect(await screen.findByRole("main", { name: "Admin login" })).toBeInTheDocument();
    expect(screen.queryByTestId("cb-status")).not.toBeInTheDocument();
  });
});
