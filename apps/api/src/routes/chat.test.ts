import { describe, expect, it, beforeEach } from "vitest";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { chatRoutes } from "./chat.js";
import { saveCashRequest, type CashRequestRecord } from "../lib/store.js";

const BUYER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SELLER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OUTSIDER = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const TRADE_ID = "trade-e2e-1";

// A syntactically plausible 32-byte X25519 public key, base64-encoded.
const FAKE_PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64");

function seedTrade(overrides: Partial<CashRequestRecord> = {}) {
  saveCashRequest({
    id: TRADE_ID,
    contractId: "dummy_contract",
    seller: SELLER,
    buyer: BUYER,
    amountStroops: "10000000",
    secretHex: "a".repeat(64),
    secretHashHex: "b".repeat(64),
    qrPayload: "dummy",
    status: "locked",
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("chatRoutes", () => {
  let app: any;

  beforeEach(async () => {
    app = Fastify();
    await app.register(websocket);
    await app.register(chatRoutes, { prefix: "/api/v1" });
  });

  describe("POST /chat/:tradeId/keys", () => {
    it("rejects a caller who isn't a trade participant", async () => {
      seedTrade();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/chat/${TRADE_ID}/keys?participant=${OUTSIDER}`,
        payload: { publicKey: FAKE_PUBLIC_KEY },
      });
      expect(response.statusCode).toBe(403);
    });

    it("rejects a malformed public key", async () => {
      seedTrade();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/chat/${TRADE_ID}/keys?participant=${BUYER}`,
        payload: { publicKey: "not-base64!!" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("publishes a valid key for an authorized participant", async () => {
      seedTrade();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/chat/${TRADE_ID}/keys?participant=${BUYER}`,
        payload: { publicKey: FAKE_PUBLIC_KEY },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ publicKey: FAKE_PUBLIC_KEY });
    });
  });

  describe("GET /chat/:tradeId/keys", () => {
    it("rejects a caller who isn't a trade participant", async () => {
      seedTrade();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/chat/${TRADE_ID}/keys?participant=${OUTSIDER}`,
      });
      expect(response.statusCode).toBe(403);
    });

    it("returns published keys keyed by role", async () => {
      seedTrade();
      await app.inject({
        method: "POST",
        url: `/api/v1/chat/${TRADE_ID}/keys?participant=${BUYER}`,
        payload: { publicKey: FAKE_PUBLIC_KEY },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/chat/${TRADE_ID}/keys?participant=${SELLER}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.buyer).toMatchObject({ publicKey: FAKE_PUBLIC_KEY });
      expect(body.seller).toBeNull();
    });
  });

  describe("GET /chat/:tradeId/history", () => {
    it("never contains a plaintext field, only ciphertext/nonce", async () => {
      const tradeId = "trade-e2e-history";
      seedTrade({ id: tradeId });
      await app.listen({ port: 0 });
      const actualPort = (app.server.address() as any).port;

      const WebSocket = (await import("ws")).default;
      const ws = new WebSocket(`ws://127.0.0.1:${actualPort}/api/v1/chat/${tradeId}?participant=${BUYER}`);

      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => {
          ws.send(JSON.stringify({
            type: "message",
            data: { ciphertext: "c2lsZW50aXVt", nonce: "bm9uY2UtYnl0ZXMtMjQ=" },
          }));
        });
        ws.on("message", (raw) => {
          const payload = JSON.parse(raw.toString());
          if (payload.type === "message") resolve();
        });
        ws.on("error", reject);
        setTimeout(() => reject(new Error("timed out waiting for echo")), 2000);
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/chat/${tradeId}/history?participant=${BUYER}`,
      });

      ws.close();
      await app.close();

      const body = response.json();
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]).toMatchObject({ ciphertext: "c2lsZW50aXVt", nonce: "bm9uY2UtYnl0ZXMtMjQ=" });
      expect(body.messages[0]).not.toHaveProperty("text");
    });
  });

  describe("websocket message handling", () => {
    it("rejects a message payload missing ciphertext/nonce", async () => {
      const tradeId = "trade-e2e-reject";
      seedTrade({ id: tradeId });
      await app.listen({ port: 0 });
      const actualPort = (app.server.address() as any).port;

      const WebSocket = (await import("ws")).default;
      const ws = new WebSocket(`ws://127.0.0.1:${actualPort}/api/v1/chat/${tradeId}?participant=${BUYER}`);

      const errorMessage = await new Promise<string>((resolve, reject) => {
        let joined = false;
        ws.on("open", () => {});
        ws.on("message", (raw) => {
          const payload = JSON.parse(raw.toString());
          if (payload.type === "joined") {
            joined = true;
            ws.send(JSON.stringify({ type: "message", data: { text: "plaintext leak attempt" } }));
          } else if (payload.type === "error" && joined) {
            resolve(payload.message);
          }
        });
        ws.on("error", reject);
        setTimeout(() => reject(new Error("timed out waiting for error")), 2000);
      });

      expect(errorMessage).toMatch(/ciphertext and nonce/);
      ws.close();
      await app.close();
    });
  });
});
