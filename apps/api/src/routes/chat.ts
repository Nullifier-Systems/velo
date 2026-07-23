import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { getCashRequest } from "../lib/store.js";
import type { ChatMessage } from "../lib/chat-store.js";
import { parseBody } from "../lib/validation.js";
import { verifyChatCapability } from "../lib/chat-capability.js";
import {
  getChatInfrastructure,
  type ChatInfrastructure,
  type SharedTrade,
} from "../lib/chat-infrastructure.js";

const publicKeySchema = z.object({
  publicKey: z.string().trim().regex(/^[A-Za-z0-9+/]{42,44}={0,2}$/),
});

interface ChatRouteOptions { infrastructure?: ChatInfrastructure }
interface Room {
  sockets: Set<WebSocket>;
  unsubscribe: () => Promise<void>;
}

function bearerToken(req: FastifyRequest): string | undefined {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return undefined;
}

function send(socket: WebSocket, event: object) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}

async function sharedTrade(infrastructure: ChatInfrastructure, tradeId: string): Promise<SharedTrade | null> {
  const shared = await infrastructure.getTrade(tradeId);
  if (shared) return shared;
  // Keeps local development/tests compatible while production instances use
  // registerTradeForChat at trade creation to populate Redis.
  const local = getCashRequest(tradeId);
  if (!local) return null;
  const trade = { buyer: local.buyer, seller: local.seller, status: local.status };
  await infrastructure.putTrade(tradeId, trade);
  return trade;
}

async function authenticate(
  infrastructure: ChatInfrastructure,
  tradeId: string,
  token: string | undefined,
): Promise<{ participant: string; trade: SharedTrade } | null> {
  const capability = verifyChatCapability(token);
  if (!capability || capability.tradeId !== tradeId) return null;
  const trade = await sharedTrade(infrastructure, tradeId);
  if (!trade || trade.status !== "locked") return null;
  if (capability.participant !== trade.buyer && capability.participant !== trade.seller) return null;
  return { participant: capability.participant, trade };
}

export async function chatRoutes(app: FastifyInstance, options: ChatRouteOptions = {}) {
  const infrastructure = options.infrastructure ?? getChatInfrastructure();
  const rooms = new Map<string, Room>();

  async function joinRoom(tradeId: string, socket: WebSocket) {
    let room = rooms.get(tradeId);
    if (!room) {
      const sockets = new Set<WebSocket>();
      const unsubscribe = await infrastructure.subscribe(tradeId, (event) => {
        for (const member of sockets) {
          send(member, event);
          if (event.type === "closed") member.close(4000, event.reason);
        }
      });
      room = { sockets, unsubscribe };
      rooms.set(tradeId, room);
    }
    room.sockets.add(socket);
  }

  async function leaveRoom(tradeId: string, socket: WebSocket) {
    const room = rooms.get(tradeId);
    if (!room) return;
    room.sockets.delete(socket);
    if (!room.sockets.size) {
      rooms.delete(tradeId);
      await room.unsubscribe();
    }
  }

  app.get<{ Params: { tradeId: string }; Querystring: { after?: string } }>(
    "/chat/:tradeId/history",
    async (req, reply) => {
      const auth = await authenticate(infrastructure, req.params.tradeId, bearerToken(req));
      if (!auth) return reply.code(401).send({ error: "Invalid or expired chat capability" });
      return { messages: await infrastructure.getMessages(req.params.tradeId, req.query.after) };
    },
  );

  app.post<{ Params: { tradeId: string }; Body: z.infer<typeof publicKeySchema> }>(
    "/chat/:tradeId/keys",
    async (req, reply) => {
      const auth = await authenticate(infrastructure, req.params.tradeId, bearerToken(req));
      if (!auth) return reply.code(401).send({ error: "Invalid or expired chat capability" });
      const body = parseBody(publicKeySchema, req.body, reply);
      if (!body) return;
      await infrastructure.setKey(req.params.tradeId, auth.participant, body.publicKey);
      await infrastructure.publish(req.params.tradeId, { type: "peerKey", participant: auth.participant, publicKey: body.publicKey });
      return { publicKey: body.publicKey, updatedAt: new Date().toISOString() };
    },
  );

  app.get<{ Params: { tradeId: string } }>("/chat/:tradeId/keys", async (req, reply) => {
    const auth = await authenticate(infrastructure, req.params.tradeId, bearerToken(req));
    if (!auth) return reply.code(401).send({ error: "Invalid or expired chat capability" });
    return {
      buyer: await infrastructure.getKey(req.params.tradeId, auth.trade.buyer),
      seller: await infrastructure.getKey(req.params.tradeId, auth.trade.seller),
    };
  });

  app.get<{ Params: { tradeId: string }; Querystring: { token?: string; after?: string } }>(
    "/chat/:tradeId",
    { websocket: true },
    async (connection: any, req) => {
      const socket: WebSocket = connection.socket;
      const { tradeId } = req.params;
      const auth = await authenticate(infrastructure, tradeId, req.query.token);
      if (!auth) {
        send(socket, { type: "error", message: "Invalid or expired chat capability" });
        socket.close(4001, "Unauthorized");
        return;
      }

      await joinRoom(tradeId, socket);
      const peer = auth.participant === auth.trade.buyer ? auth.trade.seller : auth.trade.buyer;
      send(socket, {
        type: "joined",
        tradeId,
        participant: auth.participant,
        peerKey: await infrastructure.getKey(tradeId, peer),
      });

      // Replaying after the caller's last received ID makes reconnects lossless.
      for (const message of await infrastructure.getMessages(tradeId, req.query.after)) {
        send(socket, { type: "message", data: message, replayed: true });
      }

      let alive = true;
      socket.on("pong", () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, Number(process.env.CHAT_HEARTBEAT_INTERVAL_MS ?? 30_000));

      socket.on("message", async (raw: Buffer | string) => {
        let payload: any;
        try { payload = JSON.parse(raw.toString()); }
        catch { return send(socket, { type: "error", message: "invalid JSON" }); }
        if (payload.type !== "message") return;
        const ciphertext = typeof payload.data?.ciphertext === "string" ? payload.data.ciphertext.trim() : "";
        const nonce = typeof payload.data?.nonce === "string" ? payload.data.nonce.trim() : "";
        if (!ciphertext || !nonce) return send(socket, { type: "error", message: "message must include ciphertext and nonce" });

        const current = await infrastructure.getTrade(tradeId);
        if (!current || current.status !== "locked") return send(socket, { type: "error", message: "Trade is no longer active" });
        const saved = await infrastructure.saveMessage({ tradeId, sender: auth.participant, ciphertext, nonce });
        await infrastructure.publish(tradeId, { type: "message", data: saved });
      });

      socket.once("close", () => {
        clearInterval(heartbeat);
        void leaveRoom(tradeId, socket);
      });
    },
  );
}

export async function notifyTradeStatus(tradeId: string, status: string) {
  const infrastructure = getChatInfrastructure();
  await infrastructure.setTradeStatus(tradeId, status as any);
  if (status === "released" || status === "refunded") {
    await infrastructure.publish(tradeId, { type: "closed", reason: `Trade ${status}` });
  }
}
