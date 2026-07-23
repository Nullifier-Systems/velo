import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatStroops,
  reconcileAndRetryRelease,
  releaseCashRequest,
  shortAddress,
} from "./api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("formatStroops", () => {
  it("formats a typical amount", () => {
    expect(formatStroops("12345678")).toBe("1.23");
  });

  it("formats a zero amount", () => {
    expect(formatStroops("0")).toBe("0.00");
  });

  it("formats an amount smaller than one whole unit", () => {
    expect(formatStroops("1234567")).toBe("0.12");
  });

  it("formats a single stroop", () => {
    expect(formatStroops("1")).toBe("0.00");
  });

  it("formats an exact whole amount with no remainder", () => {
    expect(formatStroops("10000000")).toBe("1.00");
  });

  it("formats a very large amount", () => {
    expect(formatStroops("123456789012345678")).toBe("12345678901.23");
  });

  it("truncates fractional stroops beyond two decimal places", () => {
    expect(formatStroops("10000099")).toBe("1.00");
  });
});

describe("shortAddress", () => {
  it("leaves a short address unchanged", () => {
    expect(shortAddress("abc123")).toBe("abc123");
  });

  it("leaves an address at the 12-character boundary unchanged", () => {
    expect(shortAddress("123456789012")).toBe("123456789012");
  });

  it("truncates an address just over the boundary", () => {
    expect(shortAddress("1234567890123")).toBe("12345…90123");
  });

  it("truncates a typical Stellar public key", () => {
    const address = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOPQR";
    expect(shortAddress(address)).toBe("GABCD…NOPQR");
  });

  it("handles an empty string", () => {
    expect(shortAddress("")).toBe("");
  });
});

describe("releaseCashRequest", () => {
  it("marks a dropped response as uncertain", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            setTimeout(() => reject(new TypeError("connection dropped")), 5_000);
          })
      )
    );

    const release = expect(
      releaseCashRequest("trade-1", "secret")
    ).rejects.toMatchObject({
      kind: "uncertain",
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await release;
  });

  it("marks an RPC timeout response as uncertain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "rpc_timeout" }), {
          status: 504,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(
      releaseCashRequest("trade-1", "secret")
    ).rejects.toMatchObject({
      kind: "uncertain",
    });
  });
});

describe("reconcileAndRetryRelease", () => {
  it("does not POST again when the first release already succeeded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "trade-1",
          status: "released",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reconcileAndRetryRelease("trade-1", "secret")
    ).resolves.toBe("already_released");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("retries once with the same release identity after confirming it is locked", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "trade-1",
            status: "locked",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "trade-1", status: "released" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reconcileAndRetryRelease("trade-1", "secret")
    ).resolves.toBe("released");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ secret: "secret" }),
    });
  });
});
