// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "../i18n/index.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BatchAuctionModal, { secondsUntil } from "./BatchAuctionModal.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("secondsUntil", () => {
  it("floors at 0 for a deadline already in the past", () => {
    expect(secondsUntil(new Date(Date.now() - 5_000).toISOString())).toBe(0);
  });

  it("rounds up the remaining seconds for a future deadline", () => {
    expect(secondsUntil(new Date(Date.now() + 9_400).toISOString())).toBe(10);
  });
});

describe("BatchAuctionModal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<BatchAuctionModal open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("polls /api/v1/auctions/state and shows the current phase", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({
        status: "success",
        data: {
          roundId: "round-1",
          phase: "COMMIT",
          commitDeadline: new Date(Date.now() + 10_000).toISOString(),
          revealDeadline: new Date(Date.now() + 20_000).toISOString(),
          clearingPriceStroops: null,
        },
      }),
    );

    render(<BatchAuctionModal open onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("COMMIT")).toBeInTheDocument());
  });
});
