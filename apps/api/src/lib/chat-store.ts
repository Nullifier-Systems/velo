export interface ChatMessage {
  id: string;
  tradeId: string;
  sender: string;
  ciphertext: string;
  nonce: string;
  createdAt: string;
}

const messages = new Map<string, ChatMessage[]>();

let counter = 0;

function nextId(): string {
  counter++;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function saveMessage(msg: Omit<ChatMessage, "id" | "createdAt">): ChatMessage {
  const record: ChatMessage = { ...msg, id: nextId(), createdAt: new Date().toISOString() };
  const list = messages.get(msg.tradeId) ?? [];
  list.push(record);
  messages.set(msg.tradeId, list);
  return record;
}

export function getMessages(tradeId: string): ChatMessage[] {
  return messages.get(tradeId) ?? [];
}

export function deleteMessagesForTrade(tradeId: string): number {
  const list = messages.get(tradeId) ?? [];
  const count = list.length;
  messages.delete(tradeId);
  return count;
}

export function clearChatStore(): void {
  messages.clear();
}


