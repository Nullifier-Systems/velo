export interface KeyEntry {
  publicKey: string;
  updatedAt: string;
}

const keysByTrade = new Map<string, Map<string, KeyEntry>>();

export function publishKey(tradeId: string, participant: string, publicKey: string): KeyEntry {
  let room = keysByTrade.get(tradeId);
  if (!room) {
    room = new Map();
    keysByTrade.set(tradeId, room);
  }
  const entry: KeyEntry = { publicKey, updatedAt: new Date().toISOString() };
  room.set(participant, entry);
  return entry;
}

export function getKey(tradeId: string, participant: string): KeyEntry | null {
  return keysByTrade.get(tradeId)?.get(participant) ?? null;
}

export function getKeys(tradeId: string): Map<string, KeyEntry> {
  return keysByTrade.get(tradeId) ?? new Map();
}
