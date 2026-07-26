/**
 * Background sync engine for offline-first CRDT synchronization (#305).
 *
 * Detects online/offline transitions, flushes the mutation queue, and
 * synchronizes CRDT message states when connectivity is restored.
 */

import { getPendingOps, getMessages, putMessages, clearAllData } from "./store";
import { mergeMessages, mergeClock } from "./crdt";
import { flushQueue } from "./queue";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export type SyncStatus = "online" | "offline" | "syncing";

export interface SyncState {
  status: SyncStatus;
  pendingOps: number;
}

export type SyncListener = (state: SyncState) => void;

/* ------------------------------------------------------------------ */
/*  Sync Engine                                                        */
/* ------------------------------------------------------------------ */

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export class SyncEngine {
  private status: SyncStatus = navigator.onLine ? "online" : "offline";
  private listeners = new Set<SyncListener>();
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private pollingIntervalMs: number;

  constructor(pollingIntervalMs = 15_000) {
    this.pollingIntervalMs = pollingIntervalMs;
  }

  /* ── Lifecycle ────────────────────────────────────────────────── */

  start(): void {
    this.onlineHandler = () => {
      this.setStatus("syncing");
      void this.sync().finally(() => {
        if (this.status === "syncing") this.setStatus("online");
      });
    };

    this.offlineHandler = () => {
      this.setStatus("offline");
    };

    window.addEventListener("online", this.onlineHandler);
    window.addEventListener("offline", this.offlineHandler);

    // Periodic sync check
    if (this.status === "online") {
      this.scheduleSync();
    }
  }

  stop(): void {
    if (this.onlineHandler) window.removeEventListener("online", this.onlineHandler);
    if (this.offlineHandler) window.removeEventListener("offline", this.offlineHandler);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.listeners.clear();
  }

  /* ── Listeners ────────────────────────────────────────────────── */

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    listener({ status: this.status, pendingOps: 0 }); // immediate callback
    return () => this.listeners.delete(listener);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.notify();
  }

  private async notify(): Promise<void> {
    const pendingOps = await getPendingOps().then((ops) => ops.length).catch(() => 0);
    const state: SyncState = { status: this.status, pendingOps };
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  /* ── Synchronization ──────────────────────────────────────────── */

  private scheduleSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      if (this.status === "online") {
        void this.sync().then(() => this.scheduleSync());
      }
    }, this.pollingIntervalMs);
  }

  async sync(): Promise<void> {
    this.setStatus("syncing");

    // 1. Flush pending mutations
    await flushQueue(globalThis.fetch, API_BASE);

    // 2. Re-notify with updated counts
    await this.notify();
  }

  /**
   * Sync chat messages for a specific trade.
   * Called by useChat after reconnecting.
   */
  async syncMessages(
    tradeId: string,
    fetchHistory: (tradeId: string, after?: number) => Promise<StoredMessage[]>,
  ): Promise<void> {
    try {
      const local = await getMessages(tradeId);
      const lastClock = local.length > 0 ? local[local.length - 1].clock : undefined;
      const remote = await fetchHistory(tradeId, lastClock);

      if (remote.length === 0) return;

      // Merge CRDT states
      for (const msg of remote) {
        mergeClock(msg.clock);
      }

      const merged = mergeMessages(local, remote);
      await putMessages(merged);
    } catch {
      // Sync failure is non-fatal — will retry on next cycle
    }
  }

  /* ── Cleanup ──────────────────────────────────────────────────── */

  async resetAllData(): Promise<void> {
    await clearAllData();
  }
}

/* ── Singleton ───────────────────────────────────────────────────── */

let engineInstance: SyncEngine | null = null;

export function getSyncEngine(): SyncEngine {
  if (!engineInstance) {
    engineInstance = new SyncEngine();
  }
  return engineInstance;
}

export function resetSyncEngine(): void {
  if (engineInstance) {
    engineInstance.stop();
    engineInstance = null;
  }
}
