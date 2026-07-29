import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getSyncEngine, type SyncStatus } from "../lib/sync/engine";
import { getOpCount } from "../lib/sync/store";

/* ------------------------------------------------------------------ */
/*  Context value                                                     */
/* ------------------------------------------------------------------ */

export interface SyncContextValue {
  /** Current connectivity status */
  status: SyncStatus;
  /** Number of pending operations in the offline queue */
  pendingOps: number;
  /** True when the engine is actively flushing mutations */
  isSyncing: boolean;
  /** True when the device is connected to the network */
  isOnline: boolean;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/* ------------------------------------------------------------------ */
/*  Provider                                                          */
/* ------------------------------------------------------------------ */

export function SyncProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SyncContextValue>({
    status: navigator.onLine ? "online" : "offline",
    pendingOps: 0,
    isSyncing: false,
    isOnline: navigator.onLine,
  });

  useEffect(() => {
    const engine = getSyncEngine();

    const unsubscribe = engine.subscribe((syncState) => {
      setState({
        status: syncState.status,
        pendingOps: syncState.pendingOps,
        isSyncing: syncState.status === "syncing",
        isOnline: syncState.status !== "offline",
      });
    });

    engine.start();

    // Refresh pending ops count on mount
    getOpCount().then((count) => {
      setState((prev) => ({ ...prev, pendingOps: count }));
    });

    return () => {
      unsubscribe();
      // Don't stop the engine here — it's a singleton for the app lifetime
    };
  }, []);

  return <SyncContext.Provider value={state}>{children}</SyncContext.Provider>;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) {
    throw new Error("useSync must be used inside <SyncProvider>");
  }
  return ctx;
}
