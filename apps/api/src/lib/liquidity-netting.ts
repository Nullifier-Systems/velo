/**
 * Cross-instance liquidity netting -- clearing engine (issue #277).
 *
 * Velo runs one independent escrow contract instance per settlement token, so a
 * provider active across tokens has liquidity fragmented and must post full
 * reserves in every instance. This module is the off-chain reference engine for
 * a coordinating "clearing" layer: escrow instances register obligations, the
 * engine nets them down per instance, and it enforces the one invariant that
 * actually matters -- netting can NEVER create value that is not backed by a
 * real locked reserve.
 *
 * It imports nothing from the escrow contract and changes no existing
 * behaviour. See docs/liquidity-netting.md for the invariant proof, the
 * partial-failure (atomicity) rule, and how this maps onto an on-chain
 * coordinating contract as the follow-up.
 */

const I128_MAX = (1n << 127n) - 1n;
const KEY_SEP = "\u0000";

/** A gross obligation owed within a single escrow instance (one token). */
export interface Obligation {
  id: string;
  /** Escrow instance / token identifier the obligation lives in. */
  instance: string;
  /** Party that owes value in this instance. */
  debtor: string;
  /** Party that is owed value in this instance. */
  creditor: string;
  amountStroops: bigint;
}

/** Real value a party has locked in a given escrow instance. */
export interface LockedReserve {
  instance: string;
  owner: string;
  amountStroops: bigint;
}

/** Net position of a party in an instance. Positive = net creditor, negative = net debtor. */
export interface NetPosition {
  instance: string;
  party: string;
  netStroops: bigint;
}

/** A single settlement movement the clearing layer would perform. */
export interface SettlementInstruction {
  instance: string;
  party: string;
  direction: "collect" | "payout";
  amountStroops: bigint;
}

/** A net debit that is not fully backed by locked reserves. */
export interface SettlementViolation {
  instance: string;
  party: string;
  requiredStroops: bigint;
  lockedStroops: bigint;
}

export interface SettlementResult {
  status: "settled" | "rejected";
  netPositions: NetPosition[];
  instructions: SettlementInstruction[];
  violations: SettlementViolation[];
}

function validateAmount(amount: bigint, label: string): void {
  if (amount <= 0n) {
    throw new RangeError(label + " must be positive");
  }
  if (amount > I128_MAX) {
    throw new RangeError(label + " exceeds i128 max");
  }
}

function validateObligation(o: Obligation): void {
  if (!o.id) {
    throw new TypeError("obligation.id is required");
  }
  if (!o.instance) {
    throw new TypeError("obligation.instance is required");
  }
  if (!o.debtor || !o.creditor) {
    throw new TypeError("obligation.debtor and obligation.creditor are required");
  }
  if (o.debtor === o.creditor) {
    throw new RangeError("obligation debtor and creditor must differ");
  }
  validateAmount(o.amountStroops, "obligation.amountStroops");
}

function sortPositions(a: NetPosition, b: NetPosition): number {
  if (a.instance !== b.instance) {
    return a.instance < b.instance ? -1 : 1;
  }
  if (a.party !== b.party) {
    return a.party < b.party ? -1 : 1;
  }
  return 0;
}

function assertMaxTwoInstances(netPositions: NetPosition[]): void {
  const set = new Set<string>();
  for (const p of netPositions) {
    set.add(p.instance);
  }
  if (set.size > 2) {
    throw new RangeError(
      "this netting scope supports at most 2 escrow instances, got " + set.size,
    );
  }
}

function buildReserveMap(reserves: LockedReserve[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const r of reserves) {
    validateAmount(r.amountStroops, "reserve.amountStroops");
    const k = r.instance + KEY_SEP + r.owner;
    m.set(k, (m.get(k) ?? 0n) + r.amountStroops);
  }
  return m;
}

/**
 * Net a set of gross obligations down to one position per (instance, party).
 * By construction every obligation contributes +amount to its creditor and
 * -amount to its debtor, so the net positions within each instance always sum
 * to zero -- netting neither creates nor destroys value.
 */
export function computeNetPositions(obligations: Obligation[]): NetPosition[] {
  const totals = new Map<string, { instance: string; party: string; net: bigint }>();
  const bump = (instance: string, party: string, delta: bigint): void => {
    const k = instance + KEY_SEP + party;
    const cur = totals.get(k);
    if (cur === undefined) {
      totals.set(k, { instance, party, net: delta });
    } else {
      cur.net += delta;
    }
  };
  for (const o of obligations) {
    validateObligation(o);
    bump(o.instance, o.creditor, o.amountStroops);
    bump(o.instance, o.debtor, -o.amountStroops);
  }
  return [...totals.values()]
    .map((v) => ({ instance: v.instance, party: v.party, netStroops: v.net }))
    .sort(sortPositions);
}

/**
 * Assert value conservation: within each instance the net positions must sum to
 * exactly zero. A non-zero sum means value was conjured or destroyed -- exactly
 * the "unbacked liquidity" failure the clearing layer must never allow.
 */
export function assertConservation(netPositions: NetPosition[]): void {
  const perInstance = new Map<string, bigint>();
  for (const p of netPositions) {
    perInstance.set(p.instance, (perInstance.get(p.instance) ?? 0n) + p.netStroops);
  }
  for (const [instance, sum] of perInstance) {
    if (sum !== 0n) {
      throw new Error(
        "conservation violated in instance " + instance + ": net sum " + sum.toString(),
      );
    }
  }
}

/**
 * Compute a settlement plan for obligations across (at most two) escrow
 * instances given the reserves actually locked. Every net debtor must be backed
 * by a locked reserve of at least their net debit. Settlement is ATOMIC across
 * instances: if any net debit anywhere is unbacked, nothing is settled and the
 * violations are reported -- a partially-applied cross-instance settlement is
 * precisely how unbacked value would leak.
 */
export function computeSettlement(
  obligations: Obligation[],
  reserves: LockedReserve[],
): SettlementResult {
  const netPositions = computeNetPositions(obligations);
  assertConservation(netPositions);
  assertMaxTwoInstances(netPositions);
  const reserveMap = buildReserveMap(reserves);

  const violations: SettlementViolation[] = [];
  for (const p of netPositions) {
    if (p.netStroops < 0n) {
      const required = -p.netStroops;
      const locked = reserveMap.get(p.instance + KEY_SEP + p.party) ?? 0n;
      if (required > locked) {
        violations.push({
          instance: p.instance,
          party: p.party,
          requiredStroops: required,
          lockedStroops: locked,
        });
      }
    }
  }

  if (violations.length > 0) {
    return { status: "rejected", netPositions, instructions: [], violations };
  }

  const instructions: SettlementInstruction[] = [];
  for (const p of netPositions) {
    if (p.netStroops > 0n) {
      instructions.push({
        instance: p.instance,
        party: p.party,
        direction: "payout",
        amountStroops: p.netStroops,
      });
    } else if (p.netStroops < 0n) {
      instructions.push({
        instance: p.instance,
        party: p.party,
        direction: "collect",
        amountStroops: -p.netStroops,
      });
    }
  }
  return { status: "settled", netPositions, instructions, violations: [] };
}

/**
 * Independently re-check a settlement result for unbacked value:
 * - a rejected batch must emit no instructions;
 * - a settled batch must, per instance, collect exactly what it pays out
 *   (never pay out more than collected), never exceed that instance's total
 *   locked reserves, and back every individual collection by the collector's
 *   own locked reserve.
 */
export function verifyNoUnbackedValue(
  result: SettlementResult,
  reserves: LockedReserve[],
): boolean {
  if (result.status !== "settled") {
    return result.instructions.length === 0;
  }

  const collected = new Map<string, bigint>();
  const paid = new Map<string, bigint>();
  for (const ins of result.instructions) {
    if (ins.amountStroops <= 0n) {
      return false;
    }
    const m = ins.direction === "collect" ? collected : paid;
    m.set(ins.instance, (m.get(ins.instance) ?? 0n) + ins.amountStroops);
  }

  const reserveByInstance = new Map<string, bigint>();
  for (const r of reserves) {
    reserveByInstance.set(
      r.instance,
      (reserveByInstance.get(r.instance) ?? 0n) + r.amountStroops,
    );
  }

  const instances = new Set<string>([...collected.keys(), ...paid.keys()]);
  for (const instance of instances) {
    const c = collected.get(instance) ?? 0n;
    const p = paid.get(instance) ?? 0n;
    if (c !== p) {
      return false;
    }
    if (p > (reserveByInstance.get(instance) ?? 0n)) {
      return false;
    }
  }

  const reserveMap = buildReserveMap(reserves);
  for (const ins of result.instructions) {
    if (ins.direction === "collect") {
      const locked = reserveMap.get(ins.instance + KEY_SEP + ins.party) ?? 0n;
      if (ins.amountStroops > locked) {
        return false;
      }
    }
  }
  return true;
}