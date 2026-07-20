import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { getCashRequest, type CashRequestRecord } from "../lib/store.js";
import { saveMessage, getMessages, type ChatMessage } from "../lib/chat-store.js";

const tradeRooms = new Map<string, Set<WebSocket>>();

function broadcast(tradeId: string, data: object) {
  const room = tradeRooms.get(tradeId);
  if (!room) return;
  const raw = JSON.stringify(data);
  for (const ws of room) {
    if (ws.readyState === ws.OPEN) {
      ws.send(raw);
    }
  }
}

function joinRoom(tradeId: string, ws: WebSocket) {
  let room = tradeRooms.get(tradeId);
  if (!room) {
    room = new Set();
    tradeRooms.set(tradeId, room);
  }
  room.add(ws);
}

function leaveRoom(tradeId: string, ws: WebSocket) {
  const room = tradeRooms.get(tradeId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) tradeRooms.delete(tradeId);
}

function authorize(record: CashRequestRecord | undefined, participant: string): string | null {
  if (!record) return "Trade not found";
  if (record.status !== "locked") return "Chat is only available while trade is locked";
  if (participant !== record.buyer && participant !== record.seller) return "Not a participant of this trade";
  return null;
}

export async function chatRoutes(app: FastifyInstance) {
  app.get<{ Params: { tradeId: string }; Querystring: { participant?: string } }>(
    "/chat/:tradeId/history",
    async (req, reply) => {
      const record = getCashRequest(req.params.tradeId);
      const participant = req.query.participant ?? "";
      const error = authorize(record, participant);
      if (error) {
        reply.code(403).send({ error });
        return;
      }
      return { messages: getMessages(req.params.tradeId) };
    }
  );

  app.get<{ Params: { tradeId: string }; Querystring: { participant?: string } }>(
    "/chat/:tradeId",
    { websocket: true },
    (connection: any, req) => {
      const socket = connection.socket;
      const { tradeId } = req.params;
      const participant = (req.query as any).participant ?? "";

      const record = getCashRequest(tradeId);
      const error = authorize(record, participant);
      if (error) {
        socket.send(JSON.stringify({ type: "error", message: error }));
        socket.close(4001, error);
        return;
      }

      joinRoom(tradeId, socket);

      socket.send(JSON.stringify({
        type: "joined",
        tradeId,
        participant,
      }));

      socket.on("message", (raw: Buffer | string) => {
        let payload: any;
        try {
          payload = JSON.parse(raw.toString());
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
          return;
        }

        if (payload.type !== "message") return;

        const text = typeof payload.data?.text === "string" ? payload.data.text.trim() : "";
        if (!text) return;

        const current = getCashRequest(tradeId);
        if (!current || current.status !== "locked") {
          socket.send(JSON.stringify({ type: "error", message: "Trade is no longer active" }));
          return;
        }

        const saved = saveMessage({ tradeId, sender: participant, text });
        broadcast(tradeId, { type: "message", data: saved });
      });

      socket.on("close", () => {
        leaveRoom(tradeId, socket);
      });

      const unsub = subscribeTradeStatus(tradeId, (status) => {
        if (status === "released" || status === "refunded") {
          socket.send(JSON.stringify({ type: "closed", reason: `Trade ${status}` }));
          socket.close(4000, `Trade ${status}`);
          leaveRoom(tradeId, socket);
          unsub();
        }
      });

      socket.on("close", () => unsub());
    }
  );
}

type StatusCallback = (status: string) => void;
const statusSubscribers = new Map<string, Set<StatusCallback>>();

export function subscribeTradeStatus(tradeId: string, cb: StatusCallback): () => void {
  let set = statusSubscribers.get(tradeId);
  if (!set) {
    set = new Set();
    statusSubscribers.set(tradeId, set);
  }
  set.add(cb);
  return () => { set?.delete(cb); if (set?.size === 0) statusSubscribers.delete(tradeId); };
}

export function notifyTradeStatus(tradeId: string, status: string) {
  const set = statusSubscribers.get(tradeId);
  if (!set) return;
  for (const cb of set) cb(status);
}
