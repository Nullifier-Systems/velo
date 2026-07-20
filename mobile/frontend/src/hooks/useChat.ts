import { useState, useEffect, useRef, useCallback } from "react";
import { fetchChatHistory, type ChatMessage } from "../lib/api";

const WS_BASE = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:5181`;

interface UseChatOptions {
  tradeId: string;
  participant: string;
}

export function useChat({ tradeId, participant }: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [closed, setClosed] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setClosed(false);
    setMessages([]);

    const ws = new WebSocket(`${WS_BASE}/api/v1/chat/${tradeId}?participant=${participant}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type === "message") {
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
  }, [tradeId, participant]);

  const send = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "message", data: { text } }));
  }, []);

  return { messages, send, connected, closed };
}
