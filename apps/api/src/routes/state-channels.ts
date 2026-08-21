/**
 * State Channels API Routes
 * WebSocket-based off-chain micropayment streaming with on-chain settlement.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { ApiError } from "../lib/errors.js";
import { parseBody } from "../lib/validation.js";
import { StateChannelStore } from "../lib/state-channels/state-channel-store.js";
import type { StateChannelUpdate } from "packages/shared";

const createChannelSchema = z.object({
  channelId: z.string().min(1).max(64),
  partyA: z.string().regex(/^[A-Z0-9]{56}$/),
  partyB: z.string().regex(/^[A-Z0-9]{56}$/),
  totalDepositStroops: z.string().transform((v) => BigInt(v)),
});

const stateUpdateSchema = z.object({
  messageType: z.enum(["sign_request", "sign_response", "settlement_ready"]),
  channelId: z.string(),
  sequenceNumber: z.string().transform((v) => BigInt(v)),
  partyABalance: z.string().transform((v) => BigInt(v)),
  partyBBalance: z.string().transform((v) => BigInt(v)),
  signer: z.string().regex(/^[A-Z0-9]{56}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/i),
  timestamp: z.number(),
});

interface StateChannelRouteOptions {
  db: any;
  redis: any;
}

interface WebSocketRoom {
  sockets: Set<WebSocket>;
  unsubscribe: () => Promise<void>;
}

export async function stateChannelRoutes(
  app: FastifyInstance,
  options: StateChannelRouteOptions
) {
  const store = new StateChannelStore({ db: options.db, redis: options.redis });
  const rooms = new Map<string, WebSocketRoom>();

  /**
   * POST /api/v1/state-channels
   * Initialize a new bidirectional state channel.
   */
  app.post<{ Body: z.infer<typeof createChannelSchema> }>(
    "/state-channels",
    async (req, reply) => {
      const body = parseBody(createChannelSchema, req.body, reply);
      if (!body) return;

      // Validate parties are different and sorted
      if (body.partyA === body.partyB) {
        throw new ApiError(400, "INVALID_PARTIES", "Parties must be different");
      }

      if (body.partyA > body.partyB) {
        throw new ApiError(
          400,
          "INVALID_PARTY_ORDER",
          "partyA must be less than partyB (sorted)"
        );
      }

      try {
        const channel = await store.createChannel(
          body.channelId,
          body.partyA,
          body.partyB,
          body.totalDepositStroops
        );

        return {
          channelId: channel.channelId,
          partyA: channel.partyA,
          partyB: channel.partyB,
          totalDepositStroops: channel.totalDepositStroops.toString(),
          status: channel.status,
          createdAt: channel.createdAt,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        throw new ApiError(500, "CHANNEL_CREATION_FAILED", message);
      }
    }
  );

  /**
   * GET /api/v1/state-channels/:channelId
   * Retrieve channel metadata.
   */
  app.get<{ Params: { channelId: string } }>(
    "/state-channels/:channelId",
    async (req, reply) => {
      const channel = await store.getChannel(req.params.channelId);
      if (!channel) {
        throw new ApiError(404, "CHANNEL_NOT_FOUND", "Channel does not exist");
      }

      return {
        channelId: channel.channelId,
        partyA: channel.partyA,
        partyB: channel.partyB,
        totalDepositStroops: channel.totalDepositStroops.toString(),
        nonce: channel.nonce.toString(),
        status: channel.status,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
      };
    }
  );

  /**
   * GET /api/v1/state-channels/:channelId/stream
   * WebSocket endpoint for real-time off-chain state updates.
   * Clients send signed state commitments; server broadcasts to counterparty.
   */
  app.get<{ Params: { channelId: string }; Querystring: { token?: string } }>(
    "/state-channels/:channelId/stream",
    { websocket: true },
    async (connection: any, req) => {
      const socket: WebSocket = connection.socket;
      const { channelId } = req.params;

      // Verify channel exists
      const channel = await store.getChannel(channelId);
      if (!channel) {
        socket.close(4004, "Channel not found");
        return;
      }

      // TODO: Verify token is valid for one of the parties
      // For now, accept any connection

      // Join broadcast room
      let room = rooms.get(channelId);
      if (!room) {
        const sockets = new Set<WebSocket>();
        room = { sockets, unsubscribe: async () => {} };
        rooms.set(channelId, room);
      }
      room.sockets.add(socket);

      const send = (msg: object) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      };

      send({
        type: "connected",
        channelId,
        partyA: channel.partyA,
        partyB: channel.partyB,
        timestamp: Date.now(),
      });

      // Heartbeat to detect disconnects
      const heartbeatInterval = setInterval(() => {
        send({ type: "ping", timestamp: Date.now() });
      }, 15000);

      socket.on("message", async (data: string) => {
        try {
          const update = stateUpdateSchema.parse(JSON.parse(data));

          // Persist the signed state commit
          const commit = await store.recordCommit(
            update.channelId,
            update.sequenceNumber,
            update.signer,
            "", // stateRoot: computed on settlement
            update.signature,
            update.partyABalance,
            update.partyBBalance
          );

          // Broadcast to both parties
          const response: StateChannelUpdate = {
            messageType: update.messageType,
            channelId: update.channelId,
            sequenceNumber: update.sequenceNumber,
            partyABalance: update.partyABalance,
            partyBBalance: update.partyBBalance,
            signer: update.signer,
            signature: update.signature,
            timestamp: update.timestamp,
          };

          for (const member of room.sockets) {
            if (member.readyState === member.OPEN) {
              member.send(
                JSON.stringify({
                  type: "state_update",
                  data: response,
                })
              );
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Invalid message";
          send({
            type: "error",
            message,
            timestamp: Date.now(),
          });
        }
      });

      socket.on("close", () => {
        clearInterval(heartbeatInterval);
        room.sockets.delete(socket);
        if (room.sockets.size === 0) {
          rooms.delete(channelId);
        }
      });

      socket.on("error", (err) => {
        clearInterval(heartbeatInterval);
        room.sockets.delete(socket);
      });
    }
  );

  /**
   * POST /api/v1/state-channels/:channelId/settle
   * Submit a cooperative settlement to the blockchain.
   */
  app.post<{ Params: { channelId: string }; Body: any }>(
    "/state-channels/:channelId/settle",
    async (req, reply) => {
      const { channelId } = req.params;
      const { finalSequenceNumber, initiator, partyAFinalBalance, partyBFinalBalance, merkleRoot } =
        req.body;

      try {
        const channel = await store.getChannel(channelId);
        if (!channel) {
          throw new ApiError(404, "CHANNEL_NOT_FOUND", "Channel does not exist");
        }

        // Record settlement submission
        const settlement = await store.recordSettlement(
          channelId,
          BigInt(finalSequenceNumber),
          initiator,
          BigInt(partyAFinalBalance),
          BigInt(partyBFinalBalance),
          merkleRoot
        );

        return {
          settlementId: settlement.settlementId,
          channelId: settlement.channelId,
          finalSequenceNumber: settlement.finalSequenceNumber.toString(),
          status: settlement.status,
          createdAt: settlement.createdAt,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Settlement failed";
        throw new ApiError(500, "SETTLEMENT_FAILED", message);
      }
    }
  );

  /**
   * GET /api/v1/state-channels/:channelId/latest-commit
   * Retrieve the latest committed state.
   */
  app.get<{ Params: { channelId: string } }>(
    "/state-channels/:channelId/latest-commit",
    async (req, reply) => {
      const commit = await store.getLatestCommit(req.params.channelId);
      if (!commit) {
        throw new ApiError(404, "NO_COMMITS", "No commits found for this channel");
      }

      return {
        commitId: commit.commitId,
        channelId: commit.channelId,
        sequenceNumber: commit.sequenceNumber.toString(),
        signer: commit.signer,
        stateRoot: commit.stateRoot,
        signature: commit.signature,
        partyABalance: commit.partyABalance.toString(),
        partyBBalance: commit.partyBBalance.toString(),
        createdAt: commit.createdAt,
      };
    }
  );
}
