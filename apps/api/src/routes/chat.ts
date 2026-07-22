import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { getCashRequest, type CashRequestRecord } from "../lib/store.js";
import { saveMessage, getMessages, type ChatMessage } from "../lib/chat-store.js";
import { publishKey, getKey, getKeys } from "../lib/key-store.js";
import { parseBody } from "../lib/validation.js";

// X25519 public keys are 32 raw bytes -> 44 base64 chars (with padding).
const publicKeySchema = z.object({
  publicKey: z.string().trim().regex(/^[A-Za-z0-9+/]{42,44}={0,2}$/),
});

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

  app.post<{ Params: { tradeId: string }; Querystring: { participant?: string }; Body: z.infer<typeof publicKeySchema> }>(
    "/chat/:tradeId/keys",
    async (req, reply) => {
      const record = getCashRequest(req.params.tradeId);
      const participant = req.query.participant ?? "";
      const error = authorize(record, participant);
      if (error) {
        reply.code(403).send({ error });
        return;
      }

      const body = parseBody(publicKeySchema, req.body, reply);
      if (!body) return;

      const entry = publishKey(req.params.tradeId, participant, body.publicKey);
      broadcast(req.params.tradeId, { type: "peerKey", participant, publicKey: entry.publicKey });
      return entry;
    }
  );

  app.get<{ Params: { tradeId: string }; Querystring: { participant?: string } }>(
    "/chat/:tradeId/keys",
    async (req, reply) => {
      const record = getCashRequest(req.params.tradeId);
      const participant = req.query.participant ?? "";
      const error = authorize(record, participant);
      if (error) {
        reply.code(403).send({ error });
        return;
      }

      const keys = getKeys(req.params.tradeId);
      return {
        buyer: keys.get(record!.buyer) ?? null,
        seller: keys.get(record!.seller) ?? null,
      };
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

      const peer = participant === record!.buyer ? record!.seller : record!.buyer;
      const peerKey = getKey(tradeId, peer);

      socket.send(JSON.stringify({
        type: "joined",
        tradeId,
        participant,
        peerKey,
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

        const ciphertext = typeof payload.data?.ciphertext === "string" ? payload.data.ciphertext.trim() : "";
        const nonce = typeof payload.data?.nonce === "string" ? payload.data.nonce.trim() : "";
        if (!ciphertext || !nonce) {
          socket.send(JSON.stringify({ type: "error", message: "message must include ciphertext and nonce" }));
          return;
        }

        const current = getCashRequest(tradeId);
        if (!current || current.status !== "locked") {
          socket.send(JSON.stringify({ type: "error", message: "Trade is no longer active" }));
          return;
        }

        const saved = saveMessage({ tradeId, sender: participant, ciphertext, nonce });
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
