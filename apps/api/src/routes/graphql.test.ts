import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { describe, expect, it } from "vitest";
import type { EventStore } from "../lib/stellar-event-store.js";
import { graphqlRoutes } from "./graphql.js";
import WebSocket from "ws";
import { escrowDeltaFeed } from "../lib/escrow-deltas.js";

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
});
