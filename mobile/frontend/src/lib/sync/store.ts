/**
 * IndexedDB persistence layer for offline-first CRDT sync (#305).
 *
 * Uses Dexie.js to store trades, chat messages (CRDT documents), and
 * the offline mutation queue. All data survives page reload and is
 * available for background sync when connectivity returns.
 */

import Dexie, { type Table } from "dexie";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface StoredTrade {
  id: string;
  status: string;
  amount: string;
  secretHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  tradeId: string;
  messageId: string;
  sender: string;
  ciphertext: string;
  nonce: string;
  clock: number;
  clientId: string;
  timestamp: string;
  status: "pending" | "synced" | "failed";
}

export interface QueuedOperation {
  id?: number;
  endpoint: string;
  method: string;
  body?: string;
  idempotencyKey: string;
  createdAt: string;
  status: "pending" | "syncing" | "done" | "failed";
  retryCount: number;
}

/* ------------------------------------------------------------------ */
/*  Database                                                          */
/* ------------------------------------------------------------------ */

const DB_NAME = "velo-sync";
const DB_VERSION = 1;

export class SyncDatabase extends Dexie {
  trades!: Table<StoredTrade, string>;
  messages!: Table<StoredMessage, [string, string]>;
  queue!: Table<QueuedOperation, number>;

  constructor() {
    super(DB_NAME);

    this.version(DB_VERSION).stores({
      trades: "id, status, updatedAt",
      messages: "[tradeId+messageId], tradeId, status, clock",
      queue: "++id, status, createdAt",
    });
  }
}

let dbInstance: SyncDatabase | null = null;

export function getDb(): SyncDatabase {
  if (!dbInstance) {
    dbInstance = new SyncDatabase();
  }
  return dbInstance;
}

/* ------------------------------------------------------------------ */
/*  Store operations                                                   */
/* ------------------------------------------------------------------ */

export async function getMessages(tradeId: string, after?: number): Promise<StoredMessage[]> {
  const db = getDb();
  let collection = db.messages.where("tradeId").equals(tradeId);
  if (after !== undefined) {
    collection = collection.and((m) => m.clock > after) as any;
  }
  return collection.sortBy("clock");
}

export async function putMessage(msg: StoredMessage): Promise<void> {
  const db = getDb();
  await db.messages.put(msg);
}

export async function putMessages(msgs: StoredMessage[]): Promise<void> {
  const db = getDb();
  await db.messages.bulkPut(msgs);
}

export async function getTrade(tradeId: string): Promise<StoredTrade | undefined> {
  const db = getDb();
  return db.trades.get(tradeId);
}

export async function putTrade(trade: StoredTrade): Promise<void> {
  const db = getDb();
  await db.trades.put(trade);
}

export async function getPendingOps(): Promise<QueuedOperation[]> {
  const db = getDb();
  return db.queue.where("status").equals("pending").sortBy("createdAt");
}

export async function enqueueOp(op: Omit<QueuedOperation, "id" | "retryCount" | "createdAt">): Promise<number> {
  const db = getDb();
  return db.queue.add({
    ...op,
    retryCount: 0,
    createdAt: new Date().toISOString(),
  });
}

export async function updateOpStatus(id: number, status: QueuedOperation["status"], retryCount?: number): Promise<void> {
  const db = getDb();
  await db.queue.update(id, { status, ...(retryCount !== undefined ? { retryCount } : {}) });
}

export async function getOpCount(): Promise<number> {
  const db = getDb();
  return db.queue.where("status").equals("pending").count();
}

export async function clearAllData(): Promise<void> {
  const db = getDb();
  await Promise.all([db.trades.clear(), db.messages.clear(), db.queue.clear()]);
}
