// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebhookSettings from "./WebhookSettings.js";
import "../i18n/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WebhookSettings Component (Issue #445)", () => {
  const sampleEndpoints = [
    {
      endpoint_id: "ep-111",
      user_id: "usr_alice",
      target_url: "https://alice.example.com/webhooks",
      secret_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      is_active: true,
      created_at: "2026-08-29T12:00:00.000Z",
    },
  ];

  const sampleLogs = [
    {
      delivery_id: "del-999-aaa",
      endpoint_id: "ep-111",
      event_type: "trade.refunded",
      payload: { tradeId: "trade-123" },
      signature_header: "sig-header",
      attempt_count: 5,
      status: "DEAD_LETTER" as const,
      last_response_code: 500,
      created_at: "2026-08-29T12:05:00.000Z",
    },
  ];

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.includes("/api/v1/webhooks/endpoints") && method === "GET") {
        return jsonResponse({ endpoints: sampleEndpoints });
      }
      if (url.includes("/api/v1/webhooks/logs") && method === "GET") {
        return jsonResponse({ logs: sampleLogs });
      }
      if (url.includes("/api/v1/webhooks/endpoints") && method === "POST") {
        const body = JSON.parse(String(init?.body));
        return jsonResponse(
          {
            endpoint_id: "ep-new-222",
            user_id: body.user_id,
            target_url: body.target_url,
            secret_key: "new_secret_key_12345678901234567890123456789012",
            is_active: true,
            created_at: "2026-08-29T12:10:00.000Z",
          },
          201,
        );
      }
      if (url.includes("/api/v1/webhooks/dlq/replay") && method === "POST") {
        return jsonResponse({
          replayed: 1,
          delivery_ids: ["del-999-aaa"],
        });
      }

      return jsonResponse({}, 404);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders endpoints and delivery logs", async () => {
    render(<WebhookSettings />);

    await waitFor(() => {
      expect(screen.getByText("https://alice.example.com/webhooks")).toBeInTheDocument();
      expect(screen.getByText("usr_alice")).toBeInTheDocument();
      expect(screen.getByText("trade.refunded")).toBeInTheDocument();
      expect(screen.getByText("DEAD_LETTER")).toBeInTheDocument();
    });
  });

  it("toggles secret key visibility", async () => {
    const user = userEvent.setup();
    render(<WebhookSettings />);

    await waitFor(() => {
      expect(screen.getByText("https://alice.example.com/webhooks")).toBeInTheDocument();
    });

    const revealBtn = screen.getByRole("button", { name: /reveal|mostrar/i });
    await user.click(revealBtn);

    expect(screen.getByText("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBeInTheDocument();

    const hideBtn = screen.getByRole("button", { name: /hide|ocultar/i });
    await user.click(hideBtn);

    expect(screen.getByText("••••••••••••••••••••••••••••••••")).toBeInTheDocument();
  });

  it("submits new endpoint registration form", async () => {
    const user = userEvent.setup();
    render(<WebhookSettings />);

    const userIdInput = screen.getByLabelText(/user \/ developer id|id de usuario/i);
    const targetUrlInput = screen.getByLabelText(/target https url|url https de destino/i);
    const submitBtn = screen.getByRole("button", { name: /register endpoint|registrar punto de enlace/i });

    await user.type(userIdInput, "usr_bob");
    await user.type(targetUrlInput, "https://bob.example.com/hook");
    await user.click(submitBtn);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/webhooks/endpoints"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            user_id: "usr_bob",
            target_url: "https://bob.example.com/hook",
          }),
        }),
      );
    });
  });

  it("triggers manual DLQ replay", async () => {
    const user = userEvent.setup();
    render(<WebhookSettings />);

    await waitFor(() => {
      expect(screen.getByText("DEAD_LETTER")).toBeInTheDocument();
    });

    const replayBtns = screen.getAllByRole("button", { name: /replay dlq|reintentar dlq/i });
    await user.click(replayBtns[0]);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/webhooks/dlq/replay"),
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
  });
});
