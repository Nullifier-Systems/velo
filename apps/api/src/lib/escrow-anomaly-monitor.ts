import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Server } from "@stellar/stellar-sdk/rpc";
import { sendWebhookAlert, type WebhookAlert } from "./webhook.js";

type TopicEntry = xdr.ScVal | string;

export interface EscrowMonitorEvent {
  kind: "locked" | "failed_release";
  tradeId: string;
  ledger: number;
  occurredAt: Date;
  amountStroops?: bigint;
  transactionHash?: string;
}

export interface AnomalyThresholds {
  volumeWindowMs: number;
  volumeStroops: bigint;
  lockCount: number;
  failedReleaseWindowMs: number;
  failedReleaseCount: number;
}

export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  volumeWindowMs: 5 * 60_000,
  volumeStroops: 1_000_000_000_000n,
  lockCount: 25,
  failedReleaseWindowMs: 10 * 60_000,
  failedReleaseCount: 3,
};

function native(entry: TopicEntry): unknown {
  return scValToNative(typeof entry === "string" ? xdr.ScVal.fromXDR(entry, "base64") : entry);
}

function hex(value: unknown): string | undefined {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value).toString("hex");
  return undefined;
}

export function decodeEscrowMonitorEvent(raw: {
  type?: string;
  topic?: TopicEntry[];
  value?: TopicEntry;
  ledger?: number;
  ledgerClosedAt?: string;
  inSuccessfulContractCall?: boolean;
  txHash?: string;
}): EscrowMonitorEvent | null {
  try {
    const topics = (raw.topic ?? []).map(native);
    const occurredAt = raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt) : new Date(0);
    if (topics[0] === "locked" && topics.length >= 2 && raw.value !== undefined) {
      const tradeId = hex(topics[1]);
      const amount = native(raw.value);
      if (!tradeId || (typeof amount !== "bigint" && typeof amount !== "number")) return null;
      return { kind: "locked", tradeId, amountStroops: BigInt(amount), ledger: raw.ledger ?? 0, occurredAt, transactionHash: raw.txHash };
    }

    const failed = raw.inSuccessfulContractCall === false;
    const releaseIndex = topics.findIndex((topic) => topic === "release");
    const explicitFailure = topics[0] === "release_failed";
    if (failed && (releaseIndex >= 0 || explicitFailure)) {
      const tradeId = topics.slice(explicitFailure ? 1 : releaseIndex + 1).map(hex).find(Boolean);
      if (!tradeId) return null;
      return { kind: "failed_release", tradeId, ledger: raw.ledger ?? 0, occurredAt, transactionHash: raw.txHash };
    }
  } catch {
    return null;
  }
  return null;
}

interface RpcEvents { events?: unknown[]; latestLedger?: number }

export interface EscrowAnomalyMonitorOptions {
  contractId: string;
  startLedger?: number;
  pollIntervalMs?: number;
  thresholds?: Partial<AnomalyThresholds>;
  sendAlert?: (alert: WebhookAlert) => Promise<void>;
}

export class EscrowAnomalyMonitor {
  private cursorLedger: number | undefined;
  private readonly pollIntervalMs: number;
  private readonly thresholds: AnomalyThresholds;
  private readonly sendAlert: (alert: WebhookAlert) => Promise<void>;
  private locks: EscrowMonitorEvent[] = [];
  private failures = new Map<string, EscrowMonitorEvent[]>();
  private alertedVolumeWindow = false;
  private alertedFailures = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(private readonly server: Pick<Server, "getEvents" | "getLatestLedger">, private readonly options: EscrowAnomalyMonitorOptions) {
    this.cursorLedger = options.startLedger;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.thresholds = { ...DEFAULT_ANOMALY_THRESHOLDS, ...options.thresholds };
    this.sendAlert = options.sendAlert ?? sendWebhookAlert;
  }

  async process(event: EscrowMonitorEvent): Promise<void> {
    if (event.kind === "locked") await this.processLock(event);
    else await this.processFailedRelease(event);
  }

  private async processLock(event: EscrowMonitorEvent): Promise<void> {
    const cutoff = event.occurredAt.getTime() - this.thresholds.volumeWindowMs;
    this.locks = [...this.locks.filter((item) => item.occurredAt.getTime() >= cutoff), event];
    const total = this.locks.reduce((sum, item) => sum + (item.amountStroops ?? 0n), 0n);
    const anomalous = total >= this.thresholds.volumeStroops || this.locks.length >= this.thresholds.lockCount;
    if (!anomalous) { this.alertedVolumeWindow = false; return; }
    if (this.alertedVolumeWindow) return;
    this.alertedVolumeWindow = true;
    await this.sendAlert({
      title: "Escrow volume anomaly",
      text: `Escrow lock volume crossed its ${this.thresholds.volumeWindowMs / 60_000}-minute threshold.`,
      fields: { Pattern: "unusual_volume_spike", "Contract ID": this.options.contractId, "Lock count": String(this.locks.length), "Total stroops": total.toString(), Ledger: String(event.ledger) },
    });
  }

  private async processFailedRelease(event: EscrowMonitorEvent): Promise<void> {
    const cutoff = event.occurredAt.getTime() - this.thresholds.failedReleaseWindowMs;
    const recent = [...(this.failures.get(event.tradeId) ?? []).filter((item) => item.occurredAt.getTime() >= cutoff), event];
    this.failures.set(event.tradeId, recent);
    if (recent.length < this.thresholds.failedReleaseCount) {
      this.alertedFailures.delete(event.tradeId);
      return;
    }
    if (this.alertedFailures.has(event.tradeId)) return;
    this.alertedFailures.add(event.tradeId);
    await this.sendAlert({
      title: "Repeated failed escrow releases",
      text: `Trade \`${event.tradeId}\` had ${recent.length} failed release attempts.`,
      fields: { Pattern: "repeated_failed_releases", "Contract ID": this.options.contractId, "Trade ID": event.tradeId, "Failure count": String(recent.length), Ledger: String(event.ledger) },
    });
  }

  async pollOnce(): Promise<void> {
    const startLedger = this.cursorLedger ?? (await this.server.getLatestLedger()).sequence;
    const response = await this.server.getEvents({
      startLedger,
      filters: [
        { type: "contract", contractIds: [this.options.contractId] },
        { type: "diagnostic", contractIds: [this.options.contractId] } as never,
      ],
    }) as unknown as RpcEvents;
    for (const raw of response.events ?? []) {
      const event = decodeEscrowMonitorEvent(raw as Parameters<typeof decodeEscrowMonitorEvent>[0]);
      if (event) await this.process(event);
    }
    if (response.latestLedger !== undefined) this.cursorLedger = response.latestLedger + 1;
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.polling) return;
      this.polling = true;
      try { await this.pollOnce(); } catch (error) { console.error("[escrow-monitor] poll error:", error); } finally { this.polling = false; }
    };
    this.timer = setInterval(tick, this.pollIntervalMs);
    void tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
