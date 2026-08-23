/**
 * React Hook for State Channel Lifecycle
 * Manages WebSocket connection, signing, and settlement coordination.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface StateChannelUpdate {
  messageType:
    | "sign_request"
    | "sign_response"
    | "settlement_ready"
    | "settlement_confirmed";
  channelId: string;
  sequenceNumber: bigint;
  partyABalance: bigint;
  partyBBalance: bigint;
  signer: string;
  signature: string;
  timestamp: number;
}

export interface StateChannelHookOptions {
  channelId: string;
  participantAddress: string;
  apiBaseUrl: string;
  onStateUpdate?: (update: StateChannelUpdate) => void;
  onError?: (error: Error) => void;
}

export function useStateChannel(options: StateChannelHookOptions) {
  const {
    channelId,
    participantAddress,
    apiBaseUrl,
    onStateUpdate,
    onError,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [latestBalance, setLatestBalance] = useState<{
    partyA: bigint;
    partyB: bigint;
  } | null>(null);
  const [sequenceNumber, setSequenceNumber] = useState(0n);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const messageQueueRef = useRef<StateChannelUpdate[]>([]);
  const isProcessingRef = useRef(false);

  /**
   * Connect to the state channel WebSocket stream.
   */
  const connect = useCallback(async () => {
    if (isConnected || isConnecting) {
      return;
    }

    setIsConnecting(true);

    try {
      const wsUrl = new URL(
        `/api/v1/state-channels/${channelId}/stream`,
        apiBaseUrl
      );
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

      const socket = new WebSocket(wsUrl.toString());

      socket.onopen = () => {
        console.log(`Connected to state channel ${channelId}`);
        setIsConnected(true);
        setIsConnecting(false);

        // Process any queued messages
        processMessageQueue();
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleMessage(msg);
        } catch (err) {
          onError?.(new Error(`Failed to parse message: ${err}`));
        }
      };

      socket.onerror = (event) => {
        const error = new Error("WebSocket error");
        onError?.(error);
      };

      socket.onclose = () => {
        console.log(`Disconnected from state channel ${channelId}`);
        setIsConnected(false);
        socketRef.current = null;

        // Attempt to reconnect after 5s
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, 5000);
      };

      socketRef.current = socket;
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error(String(err));
      onError?.(error);
      setIsConnecting(false);
    }
  }, [channelId, apiBaseUrl, isConnected, isConnecting, onError]);

  /**
   * Disconnect from the WebSocket.
   */
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }

    setIsConnected(false);
  }, []);

  /**
   * Send a signed state update to the counterparty.
   */
  const sendStateUpdate = useCallback(
    async (
      messageType: StateChannelUpdate["messageType"],
      partyABalance: bigint,
      partyBBalance: bigint,
      signature: string
    ) => {
      if (!isConnected) {
        messageQueueRef.current.push({
          messageType,
          channelId,
          sequenceNumber: sequenceNumber + 1n,
          partyABalance,
          partyBBalance,
          signer: participantAddress,
          signature,
          timestamp: Date.now(),
        });
        return;
      }

      const update: StateChannelUpdate = {
        messageType,
        channelId,
        sequenceNumber: sequenceNumber + 1n,
        partyABalance,
        partyBBalance,
        signer: participantAddress,
        signature,
        timestamp: Date.now(),
      };

      socketRef.current?.send(JSON.stringify(update));
      setSequenceNumber(update.sequenceNumber);
    },
    [isConnected, channelId, sequenceNumber, participantAddress]
  );

  /**
   * Handle incoming message from counterparty.
   */
  const handleMessage = (msg: any) => {
    if (msg.type === "connected") {
      console.log("Connected to channel:", msg.channelId);
      return;
    }

    if (msg.type === "ping") {
      // Respond to heartbeat
      socketRef.current?.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type === "state_update") {
      const update = msg.data as StateChannelUpdate;
      setLatestBalance({
        partyA: update.partyABalance,
        partyB: update.partyBBalance,
      });
      setSequenceNumber(update.sequenceNumber);
      onStateUpdate?.(update);
      return;
    }

    if (msg.type === "error") {
      onError?.(new Error(msg.message));
      return;
    }
  };

  /**
   * Process messages that were queued while disconnected.
   */
  const processMessageQueue = useCallback(() => {
    if (isProcessingRef.current || messageQueueRef.current.length === 0) {
      return;
    }

    isProcessingRef.current = true;

    try {
      while (messageQueueRef.current.length > 0) {
        const msg = messageQueueRef.current.shift();
        if (msg && socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify(msg));
        }
      }
    } finally {
      isProcessingRef.current = false;
    }
  }, []);

  /**
   * Request a settlement from the channel.
   */
  const requestSettlement = useCallback(
    (partyAFinalBalance: bigint, partyBFinalBalance: bigint) => {
      return sendStateUpdate(
        "settlement_ready",
        partyAFinalBalance,
        partyBFinalBalance,
        "" // Settlement signature computed server-side
      );
    },
    [sendStateUpdate]
  );

  // Auto-connect on mount
  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    isConnected,
    isConnecting,
    connect,
    disconnect,
    sendStateUpdate,
    requestSettlement,
    latestBalance,
    sequenceNumber,
    messageQueue: messageQueueRef.current,
  };
}
