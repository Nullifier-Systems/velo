/**
 * State Channels API Route Tests
 * Testing channel creation, state updates, and settlement flows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { stateChannelRoutes } from "../state-channels.js";

describe("State Channels API", () => {
  let app: FastifyInstance;
  let mockDb: any;

  beforeEach(async () => {
    mockDb = {
      query: vi.fn(),
      run: vi.fn(),
    };

    app = Fastify();
    await app.register(websocket);
    await app.register(stateChannelRoutes, {
      prefix: "/api/v1",
      db: createMockDb(),
      redis: undefined,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function createMockDb() {
    let channels: any[] = [];
    let commits: any[] = [];
    let settlements: any[] = [];

    return {
      query: vi.fn(),
      close: vi.fn(),
      // Mock postgres-style template string calls
      [Symbol.for("query.raw")]: vi.fn(),
      __proto__: {
        // Allow destructuring for template tag syntax
        async [Symbol.for("query")](...args: any[]) {
          // Mock: INSERT INTO state_channels
          if (args[0]?.includes?.("INSERT INTO state_channels")) {
            const channel = {
              channel_id: "test-channel-1",
              party_a: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
              party_b: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
              total_deposit_stroops: "1000000000",
              nonce: "0",
              status: "OPEN",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            channels.push(channel);
            return [channel];
          }

          // Mock: SELECT * FROM state_channels
          if (args[0]?.includes?.("SELECT * FROM state_channels")) {
            return channels;
          }

          // Mock: INSERT INTO state_channel_commits
          if (
            args[0]?.includes?.("INSERT INTO state_channel_commits")
          ) {
            const commit = {
              commit_id: "commit-1",
              channel_id: "test-channel-1",
              sequence_number: "1",
              signer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
              state_root: "root123",
              signature:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              party_a_balance: "500000000",
              party_b_balance: "500000000",
              created_at: new Date().toISOString(),
            };
            commits.push(commit);
            return [commit];
          }

          return [];
        },
      },
    };
  }

  describe("POST /api/v1/state-channels", () => {
    it("creates a new state channel", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/state-channels",
        payload: {
          channelId: "test-channel-1",
          partyA: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
          partyB: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
          totalDepositStroops: "1000000000",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.channelId).toBe("test-channel-1");
      expect(body.status).toBe("OPEN");
    });

    it("rejects parties that are identical", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/state-channels",
        payload: {
          channelId: "test-channel-1",
          partyA: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
          partyB: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
          totalDepositStroops: "1000000000",
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe("INVALID_PARTIES");
    });

    it("rejects unordered parties (A > B)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/state-channels",
        payload: {
          channelId: "test-channel-1",
          partyA: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
          partyB: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
          totalDepositStroops: "1000000000",
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe("INVALID_PARTY_ORDER");
    });
  });

  describe("GET /api/v1/state-channels/:channelId", () => {
    it("retrieves channel metadata", async () => {
      // First create a channel
      await app.inject({
        method: "POST",
        url: "/api/v1/state-channels",
        payload: {
          channelId: "test-channel-1",
          partyA: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
          partyB: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
          totalDepositStroops: "1000000000",
        },
      });

      // Then retrieve it
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/state-channels/test-channel-1",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.channelId).toBe("test-channel-1");
      expect(body.status).toBe("OPEN");
    });

    it("returns 404 for non-existent channel", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/state-channels/nonexistent",
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe("CHANNEL_NOT_FOUND");
    });
  });

  describe("POST /api/v1/state-channels/:channelId/settle", () => {
    it("records a settlement submission", async () => {
      // Create a channel first
      await app.inject({
        method: "POST",
        url: "/api/v1/state-channels",
        payload: {
          channelId: "test-channel-1",
          partyA: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
          partyB: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH5NCA2",
          totalDepositStroops: "1000000000",
        },
      });

      // Submit settlement
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/state-channels/test-channel-1/settle",
        payload: {
          finalSequenceNumber: "100",
          initiator:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHESFC7",
          partyAFinalBalance: "500000000",
          partyBFinalBalance: "500000000",
          merkleRoot:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe("PENDING");
      expect(body.finalSequenceNumber).toBe("100");
    });
  });
});
