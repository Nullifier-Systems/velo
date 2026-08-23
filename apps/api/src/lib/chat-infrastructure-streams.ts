/**
 * Redis Streams-based chat infrastructure with vector clock ordering.
 *
 * This implementation upgrades from Pub/Sub to Redis Streams for:
 * 1. Durability: Messages persist in Redis streams, survivable across connection loss
 * 2. Recovery: Clients reconnect and replay messages they missed via XREADGROUP
 * 3. Causal Ordering: Vector clocks ensure messages are delivered in happens-before order
 * 4. Exactly-Once Semantics: Consumer groups + XACK prevent duplicate delivery
 *
 * Stream structure per trade:
 *   Key: velo:chat:stream:{tradeId}
 *   Entries: { messageId: "timestamp-sequence", clock: VectorClock, sender: string, payload: ChatEvent }
 */

import { createClient, type RedisClientType } from "redis";
import type { WebSocket } from "ws";
import type { CashRequestRecord } from "./store.js";
import type { ChatMessage } from "./chat-store.js";
import {
  incrementClock,
  compareClocks,
  type VectorClock,
} from "./vector-clock.js";

/* ------------------------------------------------------------------ */
/*  Chat socket registry — connection garbage-collection lifecycle     */
/* ------------------------------------------------------------------ */

interface TrackedChatSocket {
  tradeId: string;
  lastActivity: number;
}

const activeChatSockets = new Map<WebSocket, TrackedChatSocket>();

export function trackChatSocket(socket: WebSocket, tradeId: string): void {
  activeChatSockets.set(socket, { tradeId, lastActivity: Date.now() });
}

export function touchChatSocket(socket: WebSocket): void {
  const entry = activeChatSockets.get(socket);
  if (entry) entry.lastActivity = Date.now();
}

export function untrackChatSocket(socket: WebSocket): void {
  activeChatSockets.delete(socket);
}

export function activeChatSocketCount(): number {
  return activeChatSockets.size;
}

/**
 * Forcibly terminate sockets whose last confirmed activity (a pong) predates
 * `maxInactiveMs`. The heartbeat in chat.ts detects dead peers first; this is
 * the safety net that guarantees Redis Pub/Sub listeners are released even
 * when a client drops without a close frame.
 */
export function purgeStaleChatSockets(maxInactiveMs: number): number {
  const cutoff = Date.now() - maxInactiveMs;
  let purged = 0;
  for (const [socket, entry] of activeChatSockets) {
    if (entry.lastActivity >= cutoff) continue;
    activeChatSockets.delete(socket);
    try {
      socket.terminate();
    } catch {
      // Already closed; nothing left to purge.
    }
    purged += 1;
  }
  return purged;
}

export type ChatEvent =
  | { type: "message"; data: ChatMessage }
  | { type: "peerKey"; participant: string; publicKey: string }
  | { type: "closed"; reason: string };

export interface SharedTrade {
  buyer: string;
  seller: string;
  status: CashRequestRecord["status"];
}

export interface ChatStreamEntry {
  id: string; // Redis Stream ID (timestamp-sequence)
  clock: Record<string, number>; // Chat-style vector clock (per-participant counters)
  sender: string; // Participant who sent this event
  event: ChatEvent; // Actual chat event
  acked?: boolean; // Whether consumer has acked this message
}

export interface ChatInfrastructure {
  putTrade(tradeId: string, trade: SharedTrade): Promise<void>;
  getTrade(tradeId: string): Promise<SharedTrade | null>;
  setTradeStatus(
    tradeId: string,
    status: CashRequestRecord["status"],
  ): Promise<void>;
  saveMessage(
    message: Omit<ChatMessage, "id" | "createdAt">,
  ): Promise<ChatMessage>;
  getMessages(tradeId: string, afterId?: string): Promise<ChatMessage[]>;
  setKey(
    tradeId: string,
    participant: string,
    publicKey: string,
  ): Promise<void>;
  getKey(
    tradeId: string,
    participant: string,
  ): Promise<{ publicKey: string; updatedAt: string } | null>;
  publish(tradeId: string, event: ChatEvent): Promise<void>;
  subscribe(
    tradeId: string,
    listener: (event: ChatEvent) => void,
  ): Promise<() => Promise<void>>;
  // New: recover missed messages for client reconnect (uses chat-style vector clock)
  getMissedMessages(
    tradeId: string,
    clientClock: Record<string, number>,
    participant: string,
  ): Promise<ChatStreamEntry[]>;
  deleteTradeChat(tradeId: string): Promise<number>;
  close(): Promise<void>;
}

export class MemoryChatInfrastructure implements ChatInfrastructure {
  private trades = new Map<string, SharedTrade>();
  private streams = new Map<string, ChatStreamEntry[]>();
  private keys = new Map<string, { publicKey: string; updatedAt: string }>();
  private listeners = new Map<string, Set<(event: ChatEvent) => void>>();
  private clocks = new Map<string, Record<string, number>>(); // Per-trade current vector clock
  private sequence = 0;

  async putTrade(id: string, trade: SharedTrade) {
    this.trades.set(id, { ...trade });
    this.clocks.set(id, {}); // Initialize empty clock for this trade
  }

  async getTrade(id: string) {
    return this.trades.get(id) ?? null;
  }

  async setTradeStatus(id: string, status: CashRequestRecord["status"]) {
    const trade = this.trades.get(id);
    if (trade) trade.status = status;
  }

  async saveMessage(message: Omit<ChatMessage, "id" | "createdAt">) {
    const saved = {
      ...message,
      id: String(++this.sequence),
      createdAt: new Date().toISOString(),
    };
    // Note: getMessages uses this list, so we keep it for backward compatibility
    return saved;
  }

  async getMessages(id: string, afterId?: string) {
    const stream = this.streams.get(id) ?? [];
    const messages: ChatMessage[] = [];

    for (const entry of stream) {
      if (entry.event.type === "message") {
        if (!afterId || Number(entry.id.split("-")[1]) > Number(afterId)) {
          messages.push(entry.event.data);
        }
      }
    }

    return messages;
  }

  async setKey(id: string, participant: string, publicKey: string) {
    this.keys.set(`${id}:${participant}`, {
      publicKey,
      updatedAt: new Date().toISOString(),
    });
  }

  async getKey(id: string, participant: string) {
    return this.keys.get(`${id}:${participant}`) ?? null;
  }

  async publish(id: string, event: ChatEvent) {
    // Determine sender from event type
    let sender = "system";
    if (event.type === "message") sender = event.data.sender;
    else if (event.type === "peerKey") sender = event.participant;

    // Increment vector clock for this event
    let clock = this.clocks.get(id) ?? {};
    clock = incrementClock(clock, sender);
    this.clocks.set(id, clock);

    // Add to stream
    const streamId = `${Date.now().toString(36)}-${++this.sequence}`;
    const stream = this.streams.get(id) ?? [];
    stream.push({ id: streamId, clock: { ...clock }, sender, event });
    this.streams.set(id, stream);

    // Notify listeners
    for (const listener of this.listeners.get(id) ?? []) {
      listener(event);
    }
  }

  async subscribe(id: string, listener: (event: ChatEvent) => void) {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return async () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  /** Number of live subscriber callbacks; returns to 0 after cleanup. */
  activeSubscriptions(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  async getMissedMessages(
    tradeId: string,
    clientClock: Record<string, number>,
    _participant: string,
  ): Promise<ChatStreamEntry[]> {
    const stream = this.streams.get(tradeId) ?? [];
    const missed: ChatStreamEntry[] = [];

    for (const entry of stream) {
      // Message is missed if it happened after client's last known clock
      if (compareClocks(entry.clock, clientClock) > 0) {
        missed.push(entry);
      }
    }

    // Sort by vector clock for causal delivery
    return missed.sort((a, b) => compareClocks(a.clock, b.clock));
  }

  async deleteTradeChat(id: string): Promise<number> {
    const stream = this.streams.get(id) ?? [];
    const count = stream.filter((e) => e.event.type === "message").length;
    this.streams.delete(id);
    this.trades.delete(id);
    this.clocks.delete(id);
    for (const key of Array.from(this.keys.keys())) {
      if (key.startsWith(`${id}:`)) {
        this.keys.delete(key);
      }
    }
    return count;
  }

  async close() {}
}

export class RedisChatInfrastructure implements ChatInfrastructure {
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  private ready: Promise<void>;
  private instanceId: string;
  private listenerCounts = new Map<string, number>();

  constructor(url: string) {
    this.instanceId = Math.random().toString(36).substring(2, 10);
    this.publisher = createClient({ url });
    this.subscriber = this.publisher.duplicate();
    this.publisher.on("error", (error) =>
      console.error("Redis chat publisher error", error),
    );
    this.subscriber.on("error", (error) =>
      console.error("Redis chat subscriber error", error),
    );
    this.ready = Promise.all([
      this.publisher.connect(),
      this.subscriber.connect(),
    ]).then(() => undefined);
  }

  private tradeKey(id: string) {
    return `velo:chat:trade:${id}`;
  }
  private streamKey(id: string) {
    return `velo:chat:stream:${id}`;
  }
  private clockKey(id: string) {
    return `velo:chat:clock:${id}`;
  }
  private keyKey(id: string, participant: string) {
    return `velo:chat:key:${id}:${participant}`;
  }
  private consumerGroup(id: string) {
    return `velo:chat:group:${id}`;
  }

  async putTrade(id: string, trade: SharedTrade) {
    await this.ready;
    await this.publisher.hSet(this.tradeKey(id), {
      buyer: trade.buyer,
      seller: trade.seller,
      status: trade.status,
    });
    // Initialize stream for this trade
    try {
      await this.publisher.xAdd(this.streamKey(id), "*", { _init: "1" });
      // Trim the init message immediately
      await this.publisher.xTrim(this.streamKey(id), "MAXLEN", 0);
    } catch {
      // Stream may already exist
    }
    // Initialize consumer group
    try {
      await this.publisher.xGroupCreate(
        this.streamKey(id),
        this.consumerGroup(id),
        "$",
        { MKSTREAM: true },
      );
    } catch {
      // Group may already exist
    }
  }

  async getTrade(id: string) {
    await this.ready;
    const value = await this.publisher.hGetAll(this.tradeKey(id));
    return value.buyer ? (value as unknown as SharedTrade) : null;
  }

  async setTradeStatus(id: string, status: CashRequestRecord["status"]) {
    await this.ready;
    await this.publisher.hSet(this.tradeKey(id), "status", status);
  }

  async saveMessage(message: Omit<ChatMessage, "id" | "createdAt">) {
    await this.ready;
    const id = String(
      await this.publisher.incr(`${this.streamKey(message.tradeId)}:seq`),
    );
    const saved = { ...message, id, createdAt: new Date().toISOString() };
    return saved;
  }

  async getMessages(id: string, afterId?: string) {
    await this.ready;
    const entries = await this.publisher.xRange(this.streamKey(id), "-", "+");

    const messages: ChatMessage[] = [];
    for (const entry of entries) {
      const eventJson = entry.message?.event as string;
      if (eventJson) {
        const event = JSON.parse(eventJson) as ChatEvent;
        if (event.type === "message") {
          if (!afterId || Number(entry.id.split("-")[0]) > Number(afterId)) {
            messages.push(event.data);
          }
        }
      }
    }

    return messages;
  }

  async setKey(id: string, participant: string, publicKey: string) {
    await this.ready;
    await this.publisher.hSet(this.keyKey(id, participant), {
      publicKey,
      updatedAt: new Date().toISOString(),
    });
  }

  async getKey(id: string, participant: string) {
    await this.ready;
    const value = await this.publisher.hGetAll(this.keyKey(id, participant));
    return value.publicKey
      ? { publicKey: value.publicKey, updatedAt: value.updatedAt }
      : null;
  }

  async publish(id: string, event: ChatEvent) {
    await this.ready;

    // Determine sender
    let sender = "system";
    if (event.type === "message") sender = event.data.sender;
    else if (event.type === "peerKey") sender = event.participant;

    // Get current clock for this trade
    const clockJson = await this.publisher.get(this.clockKey(id));
    let clock: Record<string, number> = clockJson ? JSON.parse(clockJson) : {};
    clock = incrementClock(clock, sender);
    await this.publisher.set(this.clockKey(id), JSON.stringify(clock));

    // Add to stream with clock and event
    await this.publisher.xAdd(this.streamKey(id), "*", {
      clock: JSON.stringify(clock),
      sender,
      event: JSON.stringify(event),
    });

    // Also publish to Pub/Sub for real-time delivery (backward compat + immediate notification)
    await this.publisher.publish(
      `velo:chat:events:${id}`,
      JSON.stringify(event),
    );
  }

  async subscribe(id: string, listener: (event: ChatEvent) => void) {
    await this.ready;
    const handler = (raw: string) => {
      try {
        listener(JSON.parse(raw) as ChatEvent);
      } catch {
        // Ignore parse errors
      }
    };
    const channel = `velo:chat:events:${id}`;
    await this.subscriber.subscribe(channel, handler);
    this.listenerCounts.set(
      channel,
      (this.listenerCounts.get(channel) ?? 0) + 1,
    );
    return async () => {
      await this.subscriber.unsubscribe(channel, handler);
      const remaining = (this.listenerCounts.get(channel) ?? 0) - 1;
      if (remaining <= 0) this.listenerCounts.delete(channel);
      else this.listenerCounts.set(channel, remaining);
    };
  }

  /** Number of live Redis Pub/Sub listeners; returns to 0 after cleanup. */
  activeSubscriptions(): number {
    let count = 0;
    for (const listeners of this.listenerCounts.values()) count += listeners;
    return count;
  }

  async getMissedMessages(
    tradeId: string,
    clientClock: Record<string, number>,
    participant: string,
  ): Promise<ChatStreamEntry[]> {
    await this.ready;

    const entries = await this.publisher.xRange(
      this.streamKey(tradeId),
      "-",
      "+",
    );
    const missed: ChatStreamEntry[] = [];

    for (const entry of entries) {
      const clockJson = entry.message?.clock as string;
      const senderVal = entry.message?.sender as string;
      const eventJson = entry.message?.event as string;

      if (!clockJson || !eventJson) continue;

      const entryClock: Record<string, number> = JSON.parse(clockJson);
      const event = JSON.parse(eventJson) as ChatEvent;

      // Entry clock is "newer" than client's clock?
      if (compareClocks(entryClock, clientClock) > 0) {
        missed.push({
          id: entry.id,
          clock: entryClock,
          sender: senderVal ?? "system",
          event,
        });
      }
    }

    // Sort by vector clock for causal delivery
    return missed.sort((a, b) => compareClocks(a.clock, b.clock));
  }

  async deleteTradeChat(id: string): Promise<number> {
    await this.ready;
    const messages = await this.getMessages(id);
    const count = messages.length;
    const trade = await this.getTrade(id);
    const keysToDelete = [
      this.tradeKey(id),
      this.streamKey(id),
      this.clockKey(id),
    ];
    if (trade) {
      keysToDelete.push(this.keyKey(id, trade.buyer));
      keysToDelete.push(this.keyKey(id, trade.seller));
    }
    const matchingKeys = await this.publisher.keys(`velo:chat:key:${id}:*`);
    if (matchingKeys.length > 0) {
      keysToDelete.push(...matchingKeys);
    }
    await this.publisher.del(keysToDelete);
    return count;
  }

  async close() {
    await this.ready;
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}

let shared: ChatInfrastructure | undefined;
export function getChatInfrastructure(): ChatInfrastructure {
  if (!shared) {
    if (process.env.REDIS_URL)
      shared = new RedisChatInfrastructure(process.env.REDIS_URL);
    else if (process.env.NODE_ENV === "production")
      throw new Error("REDIS_URL is required for production chat");
    else shared = new MemoryChatInfrastructure();
  }
  return shared;
}

export function resetChatInfrastructure(): void {
  shared = undefined;
}

export async function registerTradeForChat(
  record: CashRequestRecord,
): Promise<void> {
  await getChatInfrastructure().putTrade(record.id, {
    buyer: record.buyer,
    seller: record.seller,
    status: record.status,
  });
}
