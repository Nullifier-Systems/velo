import { purgeStaleChatSockets } from "../chat-infrastructure-streams.js";

export interface ChatCleanupWorkerOptions {
  intervalMs?: number;
  maxInactiveMs?: number;
  onPurge?: (purged: number) => void;
}

/**
 * Safety-net garbage collector for WebSocket chat connections.
 *
 * The per-socket heartbeat in chat.ts normally tears down dead peers within
 * ~30s (two missed 15s pings). This worker re-scans the shared socket registry
 * every `intervalMs` and forcibly terminates any socket that has not answered
 * a heartbeat in `maxInactiveMs`, guaranteeing Redis Pub/Sub channels are
 * unsubscribed even if a client vanished without a close frame.
 */
export function startChatCleanupWorker(options: ChatCleanupWorkerOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 60_000;
  const maxInactiveMs = options.maxInactiveMs ?? 30_000;
  const timer = setInterval(() => {
    const purged = purgeStaleChatSockets(maxInactiveMs);
    options.onPurge?.(purged);
  }, intervalMs);
  // Never keep the process alive just for the collector.
  timer.unref();
  return () => clearInterval(timer);
}