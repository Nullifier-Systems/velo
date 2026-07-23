import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { chatRoutes } from "./chat.js";
import { issueChatCapability } from "../lib/chat-capability.js";
import { MemoryChatInfrastructure } from "../lib/chat-infrastructure.js";

const BUYER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SELLER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OUTSIDER = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const TRADE_ID = "trade-scalable-chat";

function nextFrame(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2_000);
    const handler = (raw: WebSocket.RawData) => {
      const payload = JSON.parse(raw.toString());
      if (payload.type === type) {
        clearTimeout(timeout); socket.off("message", handler); resolve(payload);
      }
    };
    socket.on("message", handler);
    socket.once("error", reject);
  });
}

describe("scalable chat WebSockets", () => {
  let infrastructure: MemoryChatInfrastructure;
  const apps: any[] = [];
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    infrastructure = new MemoryChatInfrastructure();
    process.env.CHAT_CAPABILITY_SECRET = "test-chat-capability-secret-at-least-32-bytes";
    await infrastructure.putTrade(TRADE_ID, { buyer: BUYER, seller: SELLER, status: "locked" });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await Promise.all(apps.map((app) => app.close()));
  });

  async function server() {
    const app = Fastify(); apps.push(app);
    await app.register(websocket);
    await app.register(chatRoutes, { prefix: "/api/v1", infrastructure });
    await app.listen({ port: 0 });
    return (app.server.address() as any).port as number;
  }

  async function connect(port: number, token?: string, after?: string) {
    const params = new URLSearchParams();
    if (token) params.set("token", token);
    if (after) params.set("after", after);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/chat/${TRADE_ID}?${params}`);
    sockets.push(socket);
    return socket;
  }

  async function connectAndJoin(port: number, token: string, after?: string) {
    const socket = await connect(port, token, after);
    const joined = await nextFrame(socket, "joined");
    return { socket, joined };
  }

  it("accepts an authenticated connection", async () => {
    const { joined } = await connectAndJoin(await server(), issueChatCapability(TRADE_ID, BUYER));
    expect(joined).toMatchObject({ participant: BUYER, tradeId: TRADE_ID });
  });

  it("rejects a connection without a valid capability", async () => {
    const socket = await connect(await server());
    expect(await nextFrame(socket, "error")).toMatchObject({ message: expect.stringMatching(/capability/i) });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it.each([["buyer", BUYER], ["seller", SELLER]])("allows the %s to join", async (_role, participant) => {
    const { joined } = await connectAndJoin(await server(), issueChatCapability(TRADE_ID, participant));
    expect(joined.participant).toBe(participant);
  });

  it("prevents an unrelated user from joining even with a validly signed token", async () => {
    const socket = await connect(await server(), issueChatCapability(TRADE_ID, OUTSIDER));
    expect(await nextFrame(socket, "error")).toBeTruthy();
  });

  it("rejects expired and trade-mismatched capabilities", async () => {
    const port = await server();
    const expired = await connect(port, issueChatCapability(TRADE_ID, BUYER, -1));
    expect(await nextFrame(expired, "error")).toBeTruthy();
    const wrongTrade = await connect(port, issueChatCapability("another-trade", BUYER));
    expect(await nextFrame(wrongTrade, "error")).toBeTruthy();
  });

  it("propagates messages across two Pub/Sub-backed API instances", async () => {
    const buyerPort = await server();
    const sellerPort = await server();
    const { socket: buyer } = await connectAndJoin(buyerPort, issueChatCapability(TRADE_ID, BUYER));
    const { socket: seller } = await connectAndJoin(sellerPort, issueChatCapability(TRADE_ID, SELLER));
    const received = nextFrame(seller, "message");
    buyer.send(JSON.stringify({ type: "message", data: { ciphertext: "cipher", nonce: "nonce" } }));
    expect(await received).toMatchObject({ data: { sender: BUYER, ciphertext: "cipher", nonce: "nonce" } });
  });

  it("replays missed messages after reconnecting with the last received ID", async () => {
    const port = await server();
    const buyerToken = issueChatCapability(TRADE_ID, BUYER);
    const sellerToken = issueChatCapability(TRADE_ID, SELLER);
    const { socket: buyer } = await connectAndJoin(port, buyerToken);
    const firstFrame = nextFrame(buyer, "message");
    buyer.send(JSON.stringify({ type: "message", data: { ciphertext: "one", nonce: "n1" } }));
    const first = await firstFrame;
    buyer.terminate();

    const { socket: seller } = await connectAndJoin(port, sellerToken);
    const sellerEcho = nextFrame(seller, "message");
    seller.send(JSON.stringify({ type: "message", data: { ciphertext: "two", nonce: "n2" } }));
    await sellerEcho;

    const reconnected = await connect(port, buyerToken, first.data.id);
    const joinedAgain = nextFrame(reconnected, "joined");
    const replay = nextFrame(reconnected, "message");
    await joinedAgain;
    expect(await replay).toMatchObject({ replayed: true, data: { ciphertext: "two" } });
  });

  it("recovers cleanly after a dropped connection", async () => {
    const port = await server();
    const token = issueChatCapability(TRADE_ID, BUYER);
    const { socket: dropped } = await connectAndJoin(port, token);
    dropped.terminate();
    const { joined } = await connectAndJoin(port, token);
    expect(joined).toMatchObject({ participant: BUYER });
  });
});
