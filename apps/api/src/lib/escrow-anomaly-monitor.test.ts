import { beforeEach, describe, expect, it, vi } from "vitest";
import { EscrowAnomalyMonitor, type EscrowMonitorEvent } from "./escrow-anomaly-monitor.js";
import { sendWebhookAlert } from "./webhook.js";

vi.mock("./webhook.js", () => ({ sendWebhookAlert: vi.fn().mockResolvedValue(undefined) }));

const server = {
  getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
  getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 100 }),
};

function event(kind: EscrowMonitorEvent["kind"], minute: number, overrides: Partial<EscrowMonitorEvent> = {}): EscrowMonitorEvent {
  return {
    kind,
    tradeId: "ab".repeat(32),
    ledger: 100 + minute,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, minute)),
    ...overrides,
  };
}

describe("EscrowAnomalyMonitor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("alerts when locked volume spikes and uses the existing webhook payload", async () => {
    const monitor = new EscrowAnomalyMonitor(server as never, {
      contractId: "CESCROW",
      thresholds: { volumeStroops: 1_000n, lockCount: 99 },
    });
    await monitor.process(event("locked", 0, { amountStroops: 600n }));
    await monitor.process(event("locked", 1, { amountStroops: 400n }));

    expect(sendWebhookAlert).toHaveBeenCalledTimes(1);
    expect(sendWebhookAlert).toHaveBeenCalledWith(expect.objectContaining({
      title: "Escrow volume anomaly",
      fields: expect.objectContaining({
        Pattern: "unusual_volume_spike",
        "Contract ID": "CESCROW",
        "Lock count": "2",
        "Total stroops": "1000",
      }),
    }));
  });

  it("alerts after repeated failed releases for the same trade", async () => {
    const monitor = new EscrowAnomalyMonitor(server as never, {
      contractId: "CESCROW",
      thresholds: { failedReleaseCount: 3 },
    });
    await monitor.process(event("failed_release", 0));
    await monitor.process(event("failed_release", 1));
    await monitor.process(event("failed_release", 2));

    expect(sendWebhookAlert).toHaveBeenCalledTimes(1);
    expect(sendWebhookAlert).toHaveBeenCalledWith(expect.objectContaining({
      title: "Repeated failed escrow releases",
      fields: expect.objectContaining({
        Pattern: "repeated_failed_releases",
        "Trade ID": "ab".repeat(32),
        "Failure count": "3",
      }),
    }));
  });

  it("does not alert for ordinary volume or isolated failures", async () => {
    const monitor = new EscrowAnomalyMonitor(server as never, { contractId: "CESCROW" });
    await monitor.process(event("locked", 0, { amountStroops: 10_000_000n }));
    await monitor.process(event("locked", 1, { amountStroops: 20_000_000n }));
    await monitor.process(event("failed_release", 2));
    await monitor.process(event("failed_release", 3));
    expect(sendWebhookAlert).not.toHaveBeenCalled();
  });

  it("does not combine failures from different trades", async () => {
    const monitor = new EscrowAnomalyMonitor(server as never, { contractId: "CESCROW" });
    await monitor.process(event("failed_release", 0, { tradeId: "01".repeat(32) }));
    await monitor.process(event("failed_release", 1, { tradeId: "02".repeat(32) }));
    await monitor.process(event("failed_release", 2, { tradeId: "03".repeat(32) }));
    expect(sendWebhookAlert).not.toHaveBeenCalled();
  });
});
