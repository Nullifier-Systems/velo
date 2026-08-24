import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { describe, expect, it } from "vitest";
import type { EventStore } from "../lib/stellar-event-store.js";
import { graphqlRoutes } from "./graphql.js";
import WebSocket from "ws";
import { escrowDeltaFeed } from "../lib/escrow-deltas.js";
import { saveCashRequest, updateStatus, clearStore } from "../lib/store.js";

const record = {
  contractId: "CONTRACT", escrowId: "aa".repeat(32), status: "locked" as const,
  lockedAmount: "100", releasedAmount: null, disputedBy: null, lastLedger: 42,
};

function store(): EventStore {
  return {
    checkpoint: async () => null,
    process: async () => [],
    fingerprints: async () => [],
    rollbackAfter: async () => {},
    escrow: async (contractId, escrowId) =>
      contractId === record.contractId && escrowId === record.escrowId ? record : null,
  };
}

function saveTrade(id: string, status: "locked" | "pending_signature" = "locked") {
  saveCashRequest({
    id,
    contractId: "CONTRACT",
    seller: "G_SELLER",
    buyer: "G_BUYER",
    amountStroops: "100",
    secretHex: "ff".repeat(32),
    secretHashHex: "ab".repeat(32),
    qrPayload: `velo:${id}`,
    status,
    createdAt: new Date().toISOString(),
    timeoutLedger: 9999,
  });
}

async function openSubscriptionClient(port: number) {
  const client = new WebSocket(`ws://127.0.0.1:${port}/graphql`, "graphql-transport-ws");
  const messages: any[] = [];
  client.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return { client, messages };
}

/** Resolves once `predicate` matches a message, rejecting after 1s. */
function waitFor(messages: any[], predicate: (message: any) => boolean) {
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("subscription timeout")), 1000);
    const poll = setInterval(() => {
      if (messages.some(predicate)) {
        clearTimeout(deadline); clearInterval(poll); resolve();
      }
    }, 5);
  });
}

describe("GraphQL indexed escrow API", () => {
  it("queries PostgreSQL-backed indexed state and returns null for unknown IDs", async () => {
    const app = Fastify();
    await app.register(websocket);
    await app.register(graphqlRoutes, { store: store() });
    const response = await app.inject({
      method: "POST", url: "/graphql",
      payload: {
        query: `query($contract: ID!, $id: ID!) {
          indexedEscrow(contractId: $contract, escrowId: $id) { status lockedAmount lastLedger }
        }`,
        variables: { contract: record.contractId, id: record.escrowId },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.indexedEscrow).toEqual({
      status: "locked", lockedAmount: "100", lastLedger: 42,
    });

    const unknown = await app.inject({
      method: "POST", url: "/graphql",
      payload: { query: `{ indexedEscrow(contractId: "x", escrowId: "y") { status } }` },
    });
    expect(unknown.json().data.indexedEscrow).toBeNull();
    await app.close();
  });

  it("rejects malformed GraphQL request bodies", async () => {
    const app = Fastify();
    await app.register(websocket);
    await app.register(graphqlRoutes, { store: store() });
    const response = await app.inject({ method: "POST", url: "/graphql", payload: {} });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("delivers committed escrow deltas over graphql-transport-ws", async () => {
    const app = Fastify();
    await app.register(websocket);
    await app.register(graphqlRoutes, { store: store() });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("missing test server port");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, "graphql-transport-ws");
    const messages: any[] = [];
    client.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    client.send(JSON.stringify({ type: "connection_init" }));
    client.send(JSON.stringify({
      id: "1", type: "subscribe",
      payload: {
        query: `subscription($contract: ID!, $id: ID!) {
          escrowChanged(contractId: $contract, escrowId: $id) { status lastLedger }
        }`,
        variables: { contract: record.contractId, id: record.escrowId },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    escrowDeltaFeed.publish({ ...record, status: "released", releasedAmount: "98", lastLedger: 43 });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("subscription timeout")), 1000);
      const poll = setInterval(() => {
        if (messages.some((message) => message.type === "next")) {
          clearTimeout(deadline); clearInterval(poll); resolve();
        }
      }, 5);
    });
    expect(messages.find((message) => message.type === "next").payload.data.escrowChanged)
      .toEqual({ status: "released", lastLedger: 43 });
    client.close();
    await app.close();
  });

  it("broadcasts tradeUpdated events whenever the store status changes", async () => {
    clearStore();
    const app = Fastify();
    await app.register(websocket);
    await app.register(graphqlRoutes, { store: store() });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("missing test server port");
    const tradeId = "cd".repeat(32);
    saveTrade(tradeId);

    const { client, messages } = await openSubscriptionClient(address.port);
    client.send(JSON.stringify({ type: "connection_init" }));
    client.send(JSON.stringify({
      id: "trade-1", type: "subscribe",
      payload: {
        query: `subscription($trade: ID!) {
          tradeUpdated(tradeId: $trade) { tradeId status updatedAt }
        }`,
        variables: { trade: tradeId },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The trade was created before subscribing, so the first pushed event is
    // the disputed transition…
    updateStatus(tradeId, "disputed");
    await waitFor(messages, (m) => m.type === "next" && m.id === "trade-1");
    const updates = messages
      .filter((m) => m.type === "next" && m.id === "trade-1")
      .map((m) => m.payload.data.tradeUpdated);
    expect(updates).toEqual([{ tradeId, status: "disputed", updatedAt: expect.any(String) }]);

    // …then every subsequent transition is pushed without polling.
    updateStatus(tradeId, "locked");
    updateStatus("ee".repeat(32), "refunded"); // unrelated trade must not leak in
    await waitFor(messages, (m) =>
      m.type === "next" && m.id === "trade-1" &&
      m.payload.data.tradeUpdated.status === "locked");
    const later = messages
      .filter((m) => m.type === "next" && m.id === "trade-1")
      .map((m) => m.payload.data.tradeUpdated.status);
    expect(later).toEqual(["disputed", "locked"]);
    client.close();
    await app.close();
  });

  it("completes the subscription gracefully once a terminal status arrives", async () => {
    clearStore();
    const app = Fastify();
    await app.register(websocket);
    await app.register(graphqlRoutes, { store: store() });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("missing test server port");

    for (const [id, terminal] of [
      ["11".repeat(32), "released"],
      ["22".repeat(32), "refunded"],
    ] as const) {
      saveTrade(id);
      const { client, messages } = await openSubscriptionClient(address.port);
      client.send(JSON.stringify({ type: "connection_init" }));
      client.send(JSON.stringify({
        id: `op-${terminal}`, type: "subscribe",
        payload: {
          query: `subscription($trade: ID!) { tradeUpdated(tradeId: $trade) { status } }`,
          variables: { trade: id },
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      updateStatus(id, terminal);
      await waitFor(messages, (m) => m.type === "complete" && m.id === `op-${terminal}`);

      // Terminal event was delivered first, then the operation completed.
      const statuses = messages
        .filter((m) => m.type === "next")
        .map((m) => m.payload.data.tradeUpdated.status);
      expect(statuses).toContain(terminal);

      // Post-terminal transitions are not delivered: the feed is detached.
      updateStatus(id, "disputed");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(messages.some((m) => m.type === "next" && m.payload.data.tradeUpdated.status === "disputed"))
        .toBe(false);
      client.close();
    }
    await app.close();
  });
});
