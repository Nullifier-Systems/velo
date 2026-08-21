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

  beforeEach(async () => {
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

    // Create a function that works as a template tag
    const db = async function (strings: any[], ...values: any[]) {
      const query = strings.join("?");

      if (query.includes("INSERT INTO state_channels")) {
        const channel = {
          channel_id: values[0],
          party_a: values[1],
          party_b: values[2],
          total_deposit_stroops: values[3].toString(),
          nonce: "0",
          status: "OPEN",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        channels.push(channel);
        return [channel];
      }

      if (query.includes("SELECT * FROM state_channels WHERE channel_id")) {
        return channels.filter((c) => c.channel_id === values[0]);
      }

      if (query.includes("INSERT INTO state_channel_commits")) {
        const commit = {
          commit_id: "commit-1",
          channel_id: values[0],
          sequence_number: values[1].toString(),
          signer: values[2],
          state_root: values[3],
          signature: values[4],
          party_a_balance: values[5].toString(),
          party_b_balance: values[6].toString(),
          created_at: new Date().toISOString(),
        };
        commits.push(commit);
        return [commit];
      }

      return [];
    };

    return db;
  }

  describe("POST /api/v1/state-channels", () => {
    it("creates a new state channel", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/state-channels",
        payload: {
          channelId: "test-channel-1",
          partyA:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
          partyB: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKXNJ5",
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
          partyA:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
          partyB:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
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
          partyA: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKXNJ5",
          partyB:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH7YAQ",
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
