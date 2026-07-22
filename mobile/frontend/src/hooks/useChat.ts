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

const WS_BASE = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:5181`;

interface UseChatOptions {
  tradeId: string;
  participant: string;
}

export interface DecryptedChatMessage extends ChatMessage {
  /** null when the peer's key isn't known yet, or the ciphertext failed to authenticate. */
  text: string | null;
}

export function useChat({ tradeId, participant }: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [closed, setClosed] = useState(false);
  const [peerPublicKeyB64, setPeerPublicKeyB64] = useState<string | null>(null);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [keyChanged, setKeyChanged] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const keyPairRef = useRef<ReturnType<typeof getOrCreateKeyPair> | null>(null);

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

    const keyPair = getOrCreateKeyPair(participant);
    keyPairRef.current = keyPair;

    const ws = new WebSocket(`${WS_BASE}/api/v1/chat/${tradeId}?participant=${participant}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      publishChatKey(tradeId, participant, toBase64(keyPair.publicKey)).catch(() => {});
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
        setMessages((prev) => [...prev, payload.data]);
      } else if (payload.type === "closed") {
        setClosed(true);
        ws.close();
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
    };

    fetchChatHistory(tradeId, participant).then((res) => {
      if (res.messages) setMessages(res.messages);
    }).catch(() => {});

    return () => {
      ws.close();
    };
  }, [tradeId, participant, applyPeerKey]);

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
      if (!ws || ws.readyState !== WebSocket.OPEN || !keyPair || !peerPublicKeyB64) return;

      const { ciphertext, nonce } = encryptMessage(text, fromBase64(peerPublicKeyB64), keyPair.secretKey);
      ws.send(JSON.stringify({ type: "message", data: { ciphertext, nonce } }));
    },
    [peerPublicKeyB64]
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
