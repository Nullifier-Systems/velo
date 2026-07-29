import { describe, expect, it } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { decodeEscrowEvent } from "./escrow-events.js";

const id = new Uint8Array(32).fill(0xab);
const base = {
  id: "0000000000000042-0000000001",
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  ledger: 42,
};

function event(kind: string, value: unknown) {
  return {
    ...base,
    topic: [nativeToScVal(kind, { type: "symbol" }), nativeToScVal(id)],
    value: nativeToScVal(value),
  };
}

describe("decodeEscrowEvent", () => {
  it("decodes the contract's locked event", () => {
    expect(decodeEscrowEvent(event("locked", 1000n)))?.toMatchObject({
      type: "locked",
      escrowId: "ab".repeat(32),
      amount: "1000",
      ledger: 42,
    });
  });

  it("decodes released and disputed payloads", () => {
    expect(decodeEscrowEvent(event("released", 975n))?.amount).toBe("975");
    expect(decodeEscrowEvent(event("disputed", ["GBUYER"]))?.actor).toBe("GBUYER");
  });

  it("ignores unrelated and malformed events safely", () => {
    expect(decodeEscrowEvent(event("refunded", 1000n))).toBeNull();
    expect(decodeEscrowEvent({ ...base, topic: ["invalid"] })).toBeNull();
  });
});
