import { describe, it, expect } from "vitest";
import {
  computeNetPositions,
  computeSettlement,
  assertConservation,
  verifyNoUnbackedValue,
  type Obligation,
  type LockedReserve,
  type NetPosition,
} from "./liquidity-netting.js";

const usdc = "escrow-usdc";
const xlm = "escrow-xlm";

// Provider P is active in both instances: it owes in each, yet nets to a
// creditor in both, so it should end up needing zero reserve anywhere.
function twoInstanceObligations(): Obligation[] {
  return [
    { id: "u1", instance: usdc, debtor: "A", creditor: "P", amountStroops: 100n },
    { id: "u2", instance: usdc, debtor: "P", creditor: "B", amountStroops: 40n },
    { id: "x1", instance: xlm, debtor: "P", creditor: "C", amountStroops: 30n },
    { id: "x2", instance: xlm, debtor: "D", creditor: "P", amountStroops: 50n },
  ];
}

function fullReserves(): LockedReserve[] {
  return [
    { instance: usdc, owner: "A", amountStroops: 100n },
    { instance: xlm, owner: "D", amountStroops: 50n },
  ];
}

describe("computeNetPositions", () => {
  it("nets obligations per instance and conserves value", () => {
    const net = computeNetPositions(twoInstanceObligations());
    expect(() => assertConservation(net)).not.toThrow();
    const find = (inst: string, party: string): bigint | undefined =>
      net.find((p) => p.instance === inst && p.party === party)?.netStroops;
    expect(find(usdc, "A")).toBe(-100n);
    expect(find(usdc, "P")).toBe(60n);
    expect(find(usdc, "B")).toBe(40n);
    expect(find(xlm, "P")).toBe(20n);
    expect(find(xlm, "C")).toBe(30n);
    expect(find(xlm, "D")).toBe(-50n);
  });

  it("rejects self-dealing and non-positive obligations", () => {
    expect(() =>
      computeNetPositions([
        { id: "bad", instance: usdc, debtor: "A", creditor: "A", amountStroops: 10n },
      ]),
    ).toThrow();
    expect(() =>
      computeNetPositions([
        { id: "bad", instance: usdc, debtor: "A", creditor: "B", amountStroops: 0n },
      ]),
    ).toThrow();
  });
});

describe("computeSettlement", () => {
  it("settles a provider netted across two instances with correct balances", () => {
    const reserves = fullReserves();
    const result = computeSettlement(twoInstanceObligations(), reserves);
    expect(result.status).toBe("settled");
    expect(result.violations).toEqual([]);
    expect(verifyNoUnbackedValue(result, reserves)).toBe(true);
    // P owes in both instances but nets to a creditor, so it collects nothing.
    const pCollects = result.instructions.filter(
      (i) => i.party === "P" && i.direction === "collect",
    );
    expect(pCollects).toEqual([]);
  });

  it("reduces a provider's reserve requirement below its gross obligations", () => {
    const obligations = twoInstanceObligations();
    const grossForP = obligations
      .filter((o) => o.debtor === "P")
      .reduce((sum, o) => sum + o.amountStroops, 0n);
    expect(grossForP).toBe(70n);
    const net = computeNetPositions(obligations);
    const nettedDebitForP = net
      .filter((p) => p.party === "P" && p.netStroops < 0n)
      .reduce((sum, p) => sum - p.netStroops, 0n);
    expect(nettedDebitForP).toBe(0n);
    expect(nettedDebitForP).toBeLessThan(grossForP);
  });

  it("rejects settlement that would extract more than the locked reserve", () => {
    const thin: LockedReserve[] = [
      { instance: usdc, owner: "A", amountStroops: 90n },
      { instance: xlm, owner: "D", amountStroops: 50n },
    ];
    const result = computeSettlement(twoInstanceObligations(), thin);
    expect(result.status).toBe("rejected");
    expect(result.instructions).toEqual([]);
    expect(result.violations).toContainEqual({
      instance: usdc,
      party: "A",
      requiredStroops: 100n,
      lockedStroops: 90n,
    });
    expect(verifyNoUnbackedValue(result, thin)).toBe(true);
  });

  it("is atomic across instances: one unbacked instance rejects the whole batch", () => {
    const partial: LockedReserve[] = [
      { instance: usdc, owner: "A", amountStroops: 100n },
      { instance: xlm, owner: "D", amountStroops: 40n },
    ];
    const result = computeSettlement(twoInstanceObligations(), partial);
    expect(result.status).toBe("rejected");
    // No USDC instructions emitted even though USDC alone was fully backed.
    expect(result.instructions).toEqual([]);
    expect(result.violations.map((v) => v.instance)).toContain(xlm);
  });

  it("rejects netting across more than two instances (out of scope)", () => {
    const three: Obligation[] = [
      ...twoInstanceObligations(),
      { id: "e1", instance: "escrow-eurc", debtor: "A", creditor: "B", amountStroops: 10n },
    ];
    expect(() => computeSettlement(three, fullReserves())).toThrow();
  });
});

describe("assertConservation", () => {
  it("detects a fabricated net set that conjures unbacked value", () => {
    const bogus: NetPosition[] = [
      { instance: usdc, party: "A", netStroops: -100n },
      { instance: usdc, party: "P", netStroops: 140n },
    ];
    expect(() => assertConservation(bogus)).toThrow();
  });
});