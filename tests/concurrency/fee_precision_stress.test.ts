import { describe, it, expect } from "vitest";
import {
  computeTrancheFeeStroops,
  applyNetPayout,
  verifyFeeInvariant,
  FeeArithmeticOverflowError,
  I128_MAX,
} from "../../apps/api/src/lib/fee-math.js";
import {
  auditTranche,
  runFeeAudit,
  createInMemoryFeeAuditStore,
} from "../../apps/api/src/lib/workers/feeAuditWorker.js";

/**
 * Fee Precision Concurrency Stress Test (Issue #381).
 *
 * Drives 50 concurrent tranche releases across variable amount sizes
 * (micro-tranches, ordinary amounts, and the largest lockable amount)
 * through Promise.all() and asserts that fee accounting balances match
 * exactly across ALL trades:
 *
 *   gross == fee + net, fee >= 1 stroop (never truncated to zero),
 *   and overflow surfaces as an error instead of silent wraparound.
 */
describe("Fee Precision Concurrency Stress Test (Issue #381)", () => {
  const FEE_BPS = 250; // 2.5%
  const MAX_LOCKABLE = I128_MAX / 10_000n; // contract lock() upper bound

  /** 50 trades spanning micro → boundary sizes, mirroring real traffic. */
  const buildReleases = () =>
    Array.from({ length: 50 }, (_, i) => {
      if (i % 10 === 0) return { tradeId: `trade-${i}`, amount: 1n }; // micro
      if (i % 10 === 1) return { tradeId: `trade-${i}`, amount: 99n }; // truncates to 0 raw
      if (i % 10 === 2) return { tradeId: `trade-${i}`, amount: MAX_LOCKABLE };
      return { tradeId: `trade-${i}`, amount: BigInt(1_000 + i * 7_777) };
    });

  it("50 concurrent tranche releases keep exact accounting across all trades", async () => {
    const releases = buildReleases();

    const settled = await Promise.all(
      releases.map(async (r) => {
        // Mirrors the route pre-check + on-chain settlement per release.
        const fee = computeTrancheFeeStroops(r.amount, FEE_BPS);
        const net = applyNetPayout(r.amount, fee);
        return { ...r, fee, net, ok: verifyFeeInvariant(r.amount, fee, net) };
      }),
    );

    // Every single trade balanced.
    expect(settled.every((s) => s.ok)).toBe(true);

    // Global accounting matches exactly across all trades.
    const totalGross = settled.reduce((acc, s) => acc + s.amount, 0n);
    const totalFees = settled.reduce((acc, s) => acc + s.fee, 0n);
    const totalNet = settled.reduce((acc, s) => acc + s.net, 0n);
    expect(totalGross).toBe(totalFees + totalNet);

    // No dust was created or lost anywhere in the batch.
    let reconstructed = 0n;
    for (const s of settled) reconstructed += s.fee + s.net;
    expect(reconstructed).toBe(totalGross);
  });

  it("micro-tranches never settle fee-free under concurrency", async () => {
    const releases = buildReleases();

    const fees = await Promise.all(
      releases.map(async (r) => computeTrancheFeeStroops(r.amount, FEE_BPS)),
    );

    for (const fee of fees) {
      expect(fee).toBeGreaterThanOrEqual(1n); // issue #381 minimum-fee bound
    }

    // The 99-stroop tranches would have computed a raw fee of 99*250/10000 = 2
    // — fine — but 1-stroop tranches must still pay exactly 1 stroop.
    const microFees = await Promise.all(
      Array.from({ length: 50 }, () =>
        Promise.resolve(computeTrancheFeeStroops(1n, 1)),
      ),
    );
    expect(microFees.every((f) => f === 1n)).toBe(true);
  });

  it("near-i128::MAX amounts surface overflow as an error, never silent wraparound", async () => {
    // The one amount class that cannot settle: gross exceeds i128 once
    // multiplied by the fee rate. All concurrent attempts must reject
    // with FEE_ARITHMETIC_OVERFLOW instead of producing wrapped values.
    const impossible = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        Promise.resolve().then(() =>
          computeTrancheFeeStroops(I128_MAX, FEE_BPS),
        ),
      ),
    );
    expect(impossible.every((r) => r.status === "rejected")).toBe(true);
    for (const r of impossible) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        FeeArithmeticOverflowError,
      );
    }

    // The exact boundary that CAN occur stays precise under load.
    const boundary = await Promise.all(
      Array.from({ length: 50 }, () =>
        Promise.resolve(computeTrancheFeeStroops(MAX_LOCKABLE, FEE_BPS)),
      ),
    );
    const expectedFee = (MAX_LOCKABLE * BigInt(FEE_BPS)) / 10_000n;
    expect(boundary.every((f) => f === expectedFee)).toBe(true);
  });

  it("concurrent audits record balanced rows for every settled tranche", async () => {
    const store = createInMemoryFeeAuditStore();
    const trades = buildReleases().map((r) => ({
      id: r.tradeId,
      feeBps: FEE_BPS,
      tranches: [{ index: 0, amountStroops: r.amount.toString(), released: true }],
    }));

    const report = await runFeeAudit({ trades, store });

    expect(report.audited).toBe(50);
    expect(report.violations).toBe(0);

    const rows = await store.list();
    expect(rows.length).toBe(50);
    for (const row of rows) {
      expect(
        verifyFeeInvariant(
          BigInt(row.grossAmountStroops),
          BigInt(row.calculatedFeeStroops),
          BigInt(row.netPayoutStroops),
        ),
      ).toBe(true);
    }
  });

  it("auditTranche flags arithmetic failure as a violation, not a crash", () => {
    const finding = auditTranche(
      "trade-broken",
      { index: 0, amountStroops: I128_MAX.toString() },
      FEE_BPS,
    );
    expect(finding.ok).toBe(false);
    expect(finding.reason).toContain("fee arithmetic failed");
  });
});
