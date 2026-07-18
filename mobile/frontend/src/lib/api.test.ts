import { describe, expect, it } from "vitest";
import { formatStroops, shortAddress } from "./api";

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
