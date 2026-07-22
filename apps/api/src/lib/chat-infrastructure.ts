import { createClient, type RedisClientType } from "redis";
import type { CashRequestRecord } from "./store.js";
import type { ChatMessage } from "./chat-store.js";

export type ChatEvent =
  | { type: "message"; data: ChatMessage }
  | { type: "peerKey"; participant: string; publicKey: string }
  | { type: "closed"; reason: string };

export interface SharedTrade {
  buyer: string;
  seller: string;
  status: CashRequestRecord["status"];
}

export interface ChatInfrastructure {
  putTrade(tradeId: string, trade: SharedTrade): Promise<void>;
  getTrade(tradeId: string): Promise<SharedTrade | null>;
  setTradeStatus(tradeId: string, status: CashRequestRecord["status"]): Promise<void>;
  saveMessage(message: Omit<ChatMessage, "id" | "createdAt">): Promise<ChatMessage>;
  getMessages(tradeId: string, afterId?: string): Promise<ChatMessage[]>;
  setKey(tradeId: string, participant: string, publicKey: string): Promise<void>;
  getKey(tradeId: string, participant: string): Promise<{ publicKey: string; updatedAt: string } | null>;
  publish(tradeId: string, event: ChatEvent): Promise<void>;
  subscribe(tradeId: string, listener: (event: ChatEvent) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export class MemoryChatInfrastructure implements ChatInfrastructure {
  private trades = new Map<string, SharedTrade>();
  private messages = new Map<string, ChatMessage[]>();
  private keys = new Map<string, { publicKey: string; updatedAt: string }>();
  private listeners = new Map<string, Set<(event: ChatEvent) => void>>();
  private sequence = 0;

  async putTrade(id: string, trade: SharedTrade) { this.trades.set(id, { ...trade }); }
  async getTrade(id: string) { return this.trades.get(id) ?? null; }
  async setTradeStatus(id: string, status: CashRequestRecord["status"]) {
    const trade = this.trades.get(id); if (trade) trade.status = status;
  }
  async saveMessage(message: Omit<ChatMessage, "id" | "createdAt">) {
    const saved = { ...message, id: String(++this.sequence), createdAt: new Date().toISOString() };
    const list = this.messages.get(message.tradeId) ?? [];
    list.push(saved); this.messages.set(message.tradeId, list); return saved;
  }
  async getMessages(id: string, afterId?: string) {
    const list = this.messages.get(id) ?? [];
    if (!afterId) return [...list];
    return list.filter((message) => Number(message.id) > Number(afterId));
  }
  async setKey(id: string, participant: string, publicKey: string) {
    this.keys.set(`${id}:${participant}`, { publicKey, updatedAt: new Date().toISOString() });
  }
  async getKey(id: string, participant: string) { return this.keys.get(`${id}:${participant}`) ?? null; }
  async publish(id: string, event: ChatEvent) {
    for (const listener of this.listeners.get(id) ?? []) listener(event);
  }
  async subscribe(id: string, listener: (event: ChatEvent) => void) {
    const set = this.listeners.get(id) ?? new Set(); set.add(listener); this.listeners.set(id, set);
    return async () => { set.delete(listener); if (!set.size) this.listeners.delete(id); };
  }
  async close() {}
}

export class RedisChatInfrastructure implements ChatInfrastructure {
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  private ready: Promise<void>;

  constructor(url: string) {
    this.publisher = createClient({ url });
    this.subscriber = this.publisher.duplicate();
    this.publisher.on("error", (error) => console.error("Redis chat publisher error", error));
    this.subscriber.on("error", (error) => console.error("Redis chat subscriber error", error));
    this.ready = Promise.all([this.publisher.connect(), this.subscriber.connect()]).then(() => undefined);
  }
  private tradeKey(id: string) { return `velo:chat:trade:${id}`; }
  private messagesKey(id: string) { return `velo:chat:messages:${id}`; }
  private sequenceKey(id: string) { return `velo:chat:sequence:${id}`; }
  private keyKey(id: string, participant: string) { return `velo:chat:key:${id}:${participant}`; }
  private channel(id: string) { return `velo:chat:events:${id}`; }

  async putTrade(id: string, trade: SharedTrade) {
    await this.ready;
    await this.publisher.hSet(this.tradeKey(id), { buyer: trade.buyer, seller: trade.seller, status: trade.status });
  }
  async getTrade(id: string) {
    await this.ready; const value = await this.publisher.hGetAll(this.tradeKey(id));
    return value.buyer ? value as unknown as SharedTrade : null;
  }
  async setTradeStatus(id: string, status: CashRequestRecord["status"]) { await this.ready; await this.publisher.hSet(this.tradeKey(id), "status", status); }
  async saveMessage(message: Omit<ChatMessage, "id" | "createdAt">) {
    await this.ready;
    const id = String(await this.publisher.incr(this.sequenceKey(message.tradeId)));
    const saved = { ...message, id, createdAt: new Date().toISOString() };
    await this.publisher.rPush(this.messagesKey(message.tradeId), JSON.stringify(saved));
    return saved;
  }
  async getMessages(id: string, afterId?: string) {
    await this.ready; const raw = await this.publisher.lRange(this.messagesKey(id), 0, -1);
    const messages = raw.map((value) => JSON.parse(value) as ChatMessage);
    return afterId ? messages.filter((message) => Number(message.id) > Number(afterId)) : messages;
  }
  async setKey(id: string, participant: string, publicKey: string) {
    await this.ready; await this.publisher.hSet(this.keyKey(id, participant), { publicKey, updatedAt: new Date().toISOString() });
  }
  async getKey(id: string, participant: string) {
    await this.ready; const value = await this.publisher.hGetAll(this.keyKey(id, participant));
    return value.publicKey ? { publicKey: value.publicKey, updatedAt: value.updatedAt } : null;
  }
  async publish(id: string, event: ChatEvent) { await this.ready; await this.publisher.publish(this.channel(id), JSON.stringify(event)); }
  async subscribe(id: string, listener: (event: ChatEvent) => void) {
    await this.ready;
    const handler = (raw: string) => listener(JSON.parse(raw) as ChatEvent);
    await this.subscriber.subscribe(this.channel(id), handler);
    return async () => { await this.subscriber.unsubscribe(this.channel(id), handler); };
  }
  async close() { await this.ready; await Promise.all([this.publisher.quit(), this.subscriber.quit()]); }
}

let shared: ChatInfrastructure | undefined;
export function getChatInfrastructure(): ChatInfrastructure {
  if (!shared) {
    if (process.env.REDIS_URL) shared = new RedisChatInfrastructure(process.env.REDIS_URL);
    else if (process.env.NODE_ENV === "production") throw new Error("REDIS_URL is required for production chat");
    else shared = new MemoryChatInfrastructure();
  }
  return shared;
}

export async function registerTradeForChat(record: CashRequestRecord): Promise<void> {
  await getChatInfrastructure().putTrade(record.id, { buyer: record.buyer, seller: record.seller, status: record.status });
}
