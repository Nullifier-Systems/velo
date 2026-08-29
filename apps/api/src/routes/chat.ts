import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { Pool } from "pg";
import { getCashRequest } from "../lib/store.js";
import type { ChatMessage } from "../lib/chat-store.js";
import { parseBody } from "../lib/validation.js";
import { verifyChatCapability } from "../lib/chat-capability.js";
import { ApiError } from "../lib/errors.js";
import {
  getChatInfrastructure,
  type ChatInfrastructure,
  type SharedTrade,
} from "../lib/chat-infrastructure.js";
import {
  trackChatSocket,
  touchChatSocket,
  untrackChatSocket,
} from "../lib/chat-infrastructure-streams.js";

const publicKeySchema = z.object({
  publicKey: z.string().trim().regex(/^[A-Za-z0-9+/]{42,44}={0,2}$/),
});

interface ChatRouteOptions { infrastructure?: ChatInfrastructure }
interface Room {
  sockets: Set<WebSocket>;
  unsubscribe: () => Promise<void>;
}

// Best-effort audit logging. No-ops (and never throws) when DATABASE_URL is
// unset or the migration hasn't been applied, so chat keeps working in dev.
let sessionPool: Pool | undefined;
function chatSessionPool(): Pool | undefined {
  if (!sessionPool && process.env.DATABASE_URL) {
    sessionPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return sessionPool;
}

async function recordChatConnection(
  tradeId: string,
  clientIp: string,
): Promise<string> {
  const pool = chatSessionPool();
  if (!pool) return "";
  try {
    const { rows } = await pool.query(
      `INSERT INTO chat_session_connection_logs (trade_id, client_ip)
       VALUES ($1, $2) RETURNING session_id`,
      [tradeId, clientIp ?? "unknown"],
    );
    return rows[0]?.session_id ?? "";
  } catch {
    return "";
  }
}

async function recordChatDisconnect(
  sessionId: string,
  reason: string | null,
): Promise<void> {
  if (!sessionId) return;
  const pool = chatSessionPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE chat_session_connection_logs
       SET disconnected_at = CURRENT_TIMESTAMP, disconnect_reason = $2
       WHERE session_id = $1`,
      [sessionId, reason],
    );
  } catch {
    // Table may not exist yet; audit trail is best-effort.
  }
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
      if (!auth) throw new ApiError(401, "INVALID_CHAT_CAPABILITY", "Invalid or expired chat capability");return { messages: await infrastructure.getMessages(req.params.tradeId, req.query.after) };
    },
  );

  app.post<{ Params: { tradeId: string }; Body: z.infer<typeof publicKeySchema> }>(
    "/chat/:tradeId/keys",
    async (req, reply) => {
      const auth = await authenticate(infrastructure, req.params.tradeId, bearerToken(req));
      if (!auth) throw new ApiError(401, "INVALID_CHAT_CAPABILITY", "Invalid or expired chat capability");const body = parseBody(publicKeySchema, req.body, reply);
      if (!body) return;
      await infrastructure.setKey(req.params.tradeId, auth.participant, body.publicKey);
      await infrastructure.publish(req.params.tradeId, { type: "peerKey", participant: auth.participant, publicKey: body.publicKey });
      return { publicKey: body.publicKey, updatedAt: new Date().toISOString() };
    },
  );

  app.get<{ Params: { tradeId: string } }>("/chat/:tradeId/keys", async (req, reply) => {
    const auth = await authenticate(infrastructure, req.params.tradeId, bearerToken(req));
    if (!auth) throw new ApiError(401, "INVALID_CHAT_CAPABILITY", "Invalid or expired chat capability");return {
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
      const sessionId = await recordChatConnection(tradeId, req.socket.remoteAddress ?? "unknown");
      trackChatSocket(socket, tradeId);
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

      // Heartbeat: ping every 15s and terminate after two missed pong cycles.
      // This is what detects clients that vanish without a close frame (lost
      // cellular data, force-close), so Redis Pub/Sub listeners get released.
      const heartbeatIntervalMs = Number(process.env.CHAT_HEARTBEAT_INTERVAL_MS ?? 15_000);
      const heartbeatMissedLimit = Number(process.env.CHAT_HEARTBEAT_MISSED_LIMIT ?? 2);
      let missedPongs = 0;
      socket.on("pong", () => {
        missedPongs = 0;
        touchChatSocket(socket);
      });
      const heartbeat = setInterval(() => {
        missedPongs += 1;
        if (missedPongs >= heartbeatMissedLimit) {
          send(socket, {
            type: "error",
            code: "WEBSOCKET_HEARTBEAT_TIMEOUT",
            message: "WebSocket connection closed due to missing heartbeat response.",
          });
          return socket.terminate();
        }
        socket.ping();
      }, heartbeatIntervalMs);

      socket.on("message", async (raw: Buffer | string) => {
        let payload: any;
        try { payload = JSON.parse(raw.toString()); }
        catch { return send(socket, { type: "error", message: "invalid JSON" }); }
        if (payload.type !== "message") return;
        const ciphertext = typeof payload.data?.ciphertext === "string" ? payload.data.ciphertext.trim() : "";
        const nonce = typeof payload.data?.nonce === "string" ? payload.data.nonce.trim() : "";
        const header = payload.data?.header && typeof payload.data.header === "object" ? payload.data.header : undefined;
        const x3dhInit = payload.data?.x3dhInit && typeof payload.data.x3dhInit === "object" ? payload.data.x3dhInit : undefined;
        if (!ciphertext || !nonce) return send(socket, { type: "error", message: "message must include ciphertext and nonce" });

        const current = await infrastructure.getTrade(tradeId);
        if (!current || current.status !== "locked") return send(socket, { type: "error", message: "Trade is no longer active" });
        const saved = await infrastructure.saveMessage({ tradeId, sender: auth.participant, ciphertext, nonce, header, x3dhInit });
        await infrastructure.publish(tradeId, { type: "message", data: saved });
      });

      // Explicit cleanup on every teardown path (close and error). Both
      // handlers must release the Redis Pub/Sub channel, otherwise zombie
      // subscriber callbacks accumulate and leak heap until the process OOMs.
      socket.on("error", () => socket.terminate());
      socket.once("close", () => {
        clearInterval(heartbeat);
        untrackChatSocket(socket);
        void leaveRoom(tradeId, socket);
        void recordChatDisconnect(sessionId, "abrupt");
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
