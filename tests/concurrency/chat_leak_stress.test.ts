import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { chatRoutes } from "../../apps/api/src/routes/chat.js";
import { issueChatCapability } from "../../apps/api/src/lib/chat-capability.js";
import {
  MemoryChatInfrastructure,
  RedisChatInfrastructure,
  activeChatSocketCount,
} from "../../apps/api/src/lib/chat-infrastructure-streams.js";

const BUYER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SELLER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TRADE_ID = "trade-leak-stress";

function waitForJoined(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for joined")), 5_000);
    socket.on("message", (raw) => {
      const payload = JSON.parse(raw.toString());
      if (payload.type === "joined") {
        clearTimeout(timer);
        resolve();
      }
    });
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => resolve(), 3_000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", () => {});
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 10_000) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Manual stress test (not part of the default turbo suite):
 *   npx vitest run tests/concurrency/chat_leak_stress.test.ts
 *
 * Opens 100 authenticated WebSocket chat connections and kills them abruptly
 * without sending close frames. Verifies zero zombie Redis Pub/Sub listeners
 * remain and heap stays flat. Uses Redis when REDIS_URL is set, otherwise the
 * in-memory infrastructure (listener count is the leak proxy).
 */
describe("chat WebSocket connection leak stress", () => {
  const apps: any[] = [];
  const sockets: WebSocket[] = [];
  let infra: MemoryChatInfrastructure | RedisChatInfrastructure;

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    await Promise.all(apps.map((app) => app.close()));
    if (infra) await infra.close().catch(() => {});
  });

  it("leaves zero lingering subscriptions after 100 abruptly killed connections", async () => {
    process.env.CHAT_CAPABILITY_SECRET = "test-chat-capability-secret-at-least-32-bytes";
    infra = process.env.REDIS_URL
      ? new RedisChatInfrastructure(process.env.REDIS_URL)
      : new MemoryChatInfrastructure();
    await infra.putTrade(TRADE_ID, { buyer: BUYER, seller: SELLER, status: "locked" });

    const app = Fastify();
    apps.push(app);
    await app.register(websocket);
    await app.register(chatRoutes, {
      prefix: "/api/v1",
      infrastructure: infra as never,
    });
    await app.listen({ port: 0 });
    const port = (app.server.address() as any).port as number;

    const heapBefore = process.memoryUsage().heapUsed;
    const token = issueChatCapability(TRADE_ID, BUYER);

    await Promise.all(
      Array.from({ length: 100 }, async () => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}/api/v1/chat/${TRADE_ID}?token=${encodeURIComponent(token)}`,
        );
        sockets.push(socket);
        await waitForJoined(socket);
        socket.terminate();
      }),
    );
    await Promise.all(sockets.map((socket) => waitForClose(socket)));

    // Server-side cleanup (leaveRoom -> unsubscribe, registry untrack) lands
    // a tick or two after the client observes the close, so poll for it.
    await eventually(
      () =>
        (infra as any).activeSubscriptions() === 0 &&
        activeChatSocketCount() === 0,
    );
    expect((infra as any).activeSubscriptions()).toBe(0);
    expect(activeChatSocketCount()).toBe(0);

    (globalThis as any).gc?.();
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    expect(heapGrowth).toBeLessThan(50 * 1024 * 1024);
  }, 60_000);
});