import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { fetchChatHistory, publishChatKey, type ChatMessage } from "../lib/api";
import {
  getOrCreateKeyPair,
  encryptMessage,
  decryptMessage,
  computeSafetyNumber,
  getPinnedPeerKey,
  setPinnedPeerKey,
  toBase64,
  fromBase64,
} from "../lib/e2e";
import {
  getMessages,
  putMessages,
  getSyncEngine,
  createMessage,
  mergeMessages,
  mergeClock,
} from "../lib/sync";

const WS_BASE = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:5181`;

interface UseChatOptions {
  tradeId: string;
  participant: string;
  token: string;
}

export interface DecryptedChatMessage extends ChatMessage {
  /** null when the peer's key isn't known yet, or the ciphertext failed to authenticate. */
  text: string | null;
}

/** Get or create a stable clientId for CRDT ownership. */
function getClientId(): string {
  const key = "velo:crdt:clientId";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

const CLIENT_ID = getClientId();

export function useChat({ tradeId, participant, token }: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [closed, setClosed] = useState(false);
  const [peerPublicKeyB64, setPeerPublicKeyB64] = useState<string | null>(null);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [keyChanged, setKeyChanged] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const keyPairRef = useRef<ReturnType<typeof getOrCreateKeyPair> | null>(null);
  const lastClockRef = useRef<number>(0);

  const applyPeerKey = useCallback(
    (publicKeyB64: string) => {
      const pinned = getPinnedPeerKey(tradeId);
      if (pinned && pinned !== publicKeyB64) {
        setKeyChanged(true);
      } else if (!pinned) {
        setPinnedPeerKey(tradeId, publicKeyB64);
      }
      setPeerPublicKeyB64(publicKeyB64);
    },
    [tradeId]
  );

  useEffect(() => {
    setClosed(false);
    setMessages([]);
    setPeerPublicKeyB64(null);
    setSafetyNumber(null);
    setKeyChanged(false);
    lastClockRef.current = 0;

    const keyPair = getOrCreateKeyPair(participant);
    keyPairRef.current = keyPair;

    let cancelled = false;
    let terminallyClosed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;

    // Load persisted messages from IndexedDB on mount (#305)
    getMessages(tradeId).then((stored) => {
      if (!cancelled && stored.length > 0) {
        const converted = stored.map((m) => ({
          id: m.messageId,
          tradeId: m.tradeId,
          sender: m.sender,
          ciphertext: m.ciphertext,
          nonce: m.nonce,
          createdAt: m.timestamp,
        }));
        setMessages(converted);
        lastClockRef.current = stored[stored.length - 1].clock;
      }
    }).catch(() => {});

    const addMessages = (incoming: ChatMessage[]) => {
      setMessages((previous) => {
        const byId = new Map(previous.map((m) => [m.id, m]));
        for (const msg of incoming) byId.set(msg.id, msg);
        const next = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
        return next;
      });

      // Persist incoming messages to IndexedDB via CRDT (#305)
      const stored = incoming.map((msg) =>
        createMessage(tradeId, msg.id, msg.sender, msg.ciphertext, msg.nonce, CLIENT_ID)
      );
      // Update stored messages with server clocks
      const enriched = stored.map((s, i) => ({
        ...s,
        clock: lastClockRef.current + i + 1,
        status: "synced" as const,
      }));
      if (enriched.length > 0) {
        mergeClock(enriched[enriched.length - 1].clock);
        lastClockRef.current = enriched[enriched.length - 1].clock;
        putMessages(enriched).catch(() => {});
      }
    };

    const connect = () => {
      if (cancelled || !token) return;
      const params = new URLSearchParams({ token });
      if (lastClockRef.current > 0) params.set("after", String(lastClockRef.current));
      const ws = new WebSocket(`${WS_BASE}/api/v1/chat/${tradeId}?${params}`);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt = 0;
        setConnected(true);
        publishChatKey(tradeId, token, toBase64(keyPair.publicKey)).catch(() => {});
      };

      ws.onmessage = (event) => {
        let payload: any;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (payload.type === "joined") {
          if (payload.peerKey?.publicKey) applyPeerKey(payload.peerKey.publicKey);
        } else if (payload.type === "peerKey") {
          if (payload.participant !== participant) applyPeerKey(payload.publicKey);
        } else if (payload.type === "message") {
          addMessages([payload.data]);
        } else if (payload.type === "closed") {
          terminallyClosed = true;
          setClosed(true);
          ws.close();
        }
      };

      ws.onclose = (event) => {
        setConnected(false);
        wsRef.current = null;
        if (!cancelled && !terminallyClosed && event.code !== 4000 && event.code !== 4001) {
          const delay = Math.min(30_000, 500 * 2 ** reconnectAttempt++);
          reconnectTimer = setTimeout(connect, delay + Math.random() * 250);
        }
      };
    };

    // Fetch chat history and merge with local CRDT store (#305)
    fetchChatHistory(tradeId, token).then(async (res) => {
      if (res.messages) addMessages(res.messages);
      // Sync any pending local messages after history fetch
      try {
        await getSyncEngine().syncMessages(tradeId, async (tid, after) => {
          const resp = await fetchChatHistory(tid, token, after ? String(after) : undefined);
          return resp.messages.map((m) =>
            createMessage(tid, m.id, m.sender, m.ciphertext, m.nonce, CLIENT_ID)
          );
        });
      } catch {}
    }).catch(() => {});
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [tradeId, participant, token, applyPeerKey]);

  useEffect(() => {
    if (!peerPublicKeyB64 || !keyPairRef.current) {
      setSafetyNumber(null);
      return;
    }
    let cancelled = false;
    computeSafetyNumber(keyPairRef.current.publicKey, fromBase64(peerPublicKeyB64)).then((code) => {
      if (!cancelled) setSafetyNumber(code);
    });
    return () => {
      cancelled = true;
    };
  }, [peerPublicKeyB64]);

  const send = useCallback(
    (text: string) => {
      const ws = wsRef.current;
      const keyPair = keyPairRef.current;
      if (!keyPair || !peerPublicKeyB64) return;

      const { ciphertext, nonce } = encryptMessage(text, fromBase64(peerPublicKeyB64), keyPair.secretKey);
      const messageId = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;

      // Persist to CRDT store immediately (optimistic) (#305)
      const msg = createMessage(tradeId, messageId, participant, ciphertext, nonce, CLIENT_ID);
      mergeClock(msg.clock);
      lastClockRef.current = msg.clock;
      putMessages([msg]).catch(() => {});

      // Add to local state immediately
      setMessages((prev) => {
        const next = [...prev, { id: messageId, tradeId, sender: participant, ciphertext, nonce, createdAt: msg.timestamp }];
        return next.sort((a, b) => Number(a.id) - Number(b.id));
      });

      // Send via WebSocket if connected
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "message", data: { ciphertext, nonce } }));
      }
    },
    [peerPublicKeyB64, tradeId, participant]
  );

  const decryptedMessages: DecryptedChatMessage[] = useMemo(() => {
    const keyPair = keyPairRef.current;
    if (!keyPair || !peerPublicKeyB64) {
      return messages.map((msg) => ({ ...msg, text: null }));
    }
    const peerPublicKey = fromBase64(peerPublicKeyB64);
    return messages.map((msg) => ({
      ...msg,
      text: decryptMessage(msg.ciphertext, msg.nonce, peerPublicKey, keyPair.secretKey),
    }));
  }, [messages, peerPublicKeyB64]);

  const acknowledgeKeyChange = useCallback(() => {
    if (peerPublicKeyB64) setPinnedPeerKey(tradeId, peerPublicKeyB64);
    setKeyChanged(false);
  }, [tradeId, peerPublicKeyB64]);

  return {
    messages: decryptedMessages,
    send,
    connected,
    closed,
    canSend: connected && !!peerPublicKeyB64,
    safetyNumber,
    keyChanged,
    acknowledgeKeyChange,
  };
}
