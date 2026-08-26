import { useState, useEffect, useRef, useCallback } from "react";
import type { DoubleRatchetHeader, E2EEMessagePayload, EncryptedMediaChunk } from "@velo/shared";
import {
  createDevicePrekeyBundle,
  performX3DHAliceClient,
  ratchetInitAliceClient,
  ratchetInitBobClient,
  ratchetEncryptClient,
  ratchetDecryptClient,
  type ClientRatchetState,
  fromBase64,
  toBase64,
} from "../lib/crypto/ratchet-engine";
import { computeSafetyNumber, verifySafetyNumberConstantTime } from "../../apps/api/src/lib/crypto/double-ratchet";
import { encryptMediaInChunks, decryptMediaChunks } from "../lib/crypto/media-encryptor";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const WS_BASE = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:5181`;

interface UseE2eeChatOptions {
  tradeId: string;
  ownAddress: string;
  peerAddress: string;
  token: string;
}

export interface DecryptedMessageItem {
  id: string;
  tradeId: string;
  sender: string;
  text: string | null;
  media?: { dataUrl: string; mimeType: string };
  createdAt: string;
}

export function useE2eeChat({ tradeId, ownAddress, peerAddress, token }: UseE2eeChatOptions) {
  const [messages, setMessages] = useState<DecryptedMessageItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [keyChanged, setKeyChanged] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const ratchetStateRef = useRef<ClientRatchetState | null>(null);
  const ownPrekeyBundleRef = useRef<ReturnType<typeof createDevicePrekeyBundle> | null>(null);

  // Initialize E2EE Keys and Handshake
  useEffect(() => {
    let cancelled = false;

    async function initE2ee() {
      try {
        // 1. Generate local device prekey bundle & upload to API
        const deviceBundle = createDevicePrekeyBundle(ownAddress);
        ownPrekeyBundleRef.current = deviceBundle;

        await fetch(`${API_BASE}/api/v1/e2ee/keys/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(deviceBundle.uploadRequest),
        });

        // 2. Fetch peer's prekey bundle
        const res = await fetch(`${API_BASE}/api/v1/e2ee/keys/bundle/${peerAddress}`);
        if (!res.ok) return;
        const { bundle: peerBundle } = await res.json();

        if (cancelled) return;

        // 3. Compute X3DH Handshake as Alice (Initiator)
        const { masterSecret } = await performX3DHAliceClient(
          ownAddress,
          deviceBundle.identityKey,
          peerBundle
        );

        // 4. Initialize Double Ratchet State
        const state = await ratchetInitAliceClient(masterSecret, peerBundle.signedPrekey.publicKey);
        ratchetStateRef.current = state;

        // 5. Compute Safety Number Fingerprint
        const fp = computeSafetyNumber(
          deviceBundle.uploadRequest.identityPublicKey,
          peerBundle.identityPublicKey
        );
        setSafetyNumber(fp);
      } catch (err) {
        console.error("Failed to initialize E2EE chat handshake", err);
      }
    }

    initE2ee();

    return () => {
      cancelled = true;
    };
  }, [ownAddress, peerAddress]);

  // WebSocket Connection
  useEffect(() => {
    if (!token || !tradeId) return;

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const params = new URLSearchParams({ token });
      const ws = new WebSocket(`${WS_BASE}/api/v1/chat/${tradeId}?${params}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setReconnecting(false);
      };

      ws.onmessage = async (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "message" && payload.data) {
            const rawMsg = payload.data;
            let decryptedText: string | null = null;
            let decryptedMedia: { dataUrl: string; mimeType: string } | undefined = undefined;

            if (ratchetStateRef.current && rawMsg.header) {
              try {
                const decBytes = await ratchetDecryptClient(
                  ratchetStateRef.current,
                  rawMsg.header,
                  rawMsg.ciphertext,
                  rawMsg.nonce
                );

                const textDecoded = new TextDecoder().decode(decBytes);
                // Check if message is a JSON media payload or standard text
                if (textDecoded.startsWith('{"mediaChunks":')) {
                  const mediaMeta = JSON.parse(textDecoded) as { mediaChunks: EncryptedMediaChunk[] };
                  const { data, mimeType } = await decryptMediaChunks(mediaMeta.mediaChunks, async (chunk) => {
                    return fromBase64(chunk.ciphertext);
                  });

                  let binary = "";
                  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
                  decryptedMedia = {
                    dataUrl: `data:${mimeType};base64,${btoa(binary)}`,
                    mimeType,
                  };
                } else {
                  decryptedText = textDecoded;
                }
              } catch {
                decryptedText = "[Encrypted Message - Failed to decrypt]";
              }
            } else {
              decryptedText = rawMsg.ciphertext; // fallback
            }

            setMessages((prev) => [
              ...prev,
              {
                id: rawMsg.id ?? `${Date.now()}`,
                tradeId,
                sender: rawMsg.sender,
                text: decryptedText,
                media: decryptedMedia,
                createdAt: rawMsg.createdAt ?? new Date().toISOString(),
              },
            ]);
          }
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          setReconnecting(true);
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [tradeId, token]);

  // Send Encrypted Text Message
  const sendTextMessage = useCallback(
    async (text: string) => {
      const ws = wsRef.current;
      const state = ratchetStateRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !state) return;

      const textBytes = new TextEncoder().encode(text);
      const { header, ciphertext, nonce } = await ratchetEncryptClient(state, textBytes);

      const msgPayload: E2EEMessagePayload = {
        header,
        ciphertext,
        nonce,
      };

      ws.send(JSON.stringify({ type: "message", data: msgPayload }));

      setMessages((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}`,
          tradeId,
          sender: ownAddress,
          text,
          createdAt: new Date().toISOString(),
        },
      ]);
    },
    [tradeId, ownAddress]
  );

  // Send Encrypted Image/Media File (Chunked in 64KB chunks)
  const sendMediaFile = useCallback(
    async (file: File) => {
      const ws = wsRef.current;
      const state = ratchetStateRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !state) return;

      const arrayBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(arrayBuffer);

      const chunks = await encryptMediaInChunks(fileBytes, file.type, async (chunkData) => {
        return ratchetEncryptClient(state, chunkData);
      });

      const mediaPayloadText = JSON.stringify({ mediaChunks: chunks });
      await sendTextMessage(mediaPayloadText);
    },
    [sendTextMessage]
  );

  return {
    messages,
    sendTextMessage,
    sendMediaFile,
    connected,
    reconnecting,
    safetyNumber,
    keyChanged,
    canSend: connected && !!ratchetStateRef.current,
  };
}
