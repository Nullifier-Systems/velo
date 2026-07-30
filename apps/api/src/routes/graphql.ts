import type { FastifyInstance } from "fastify";
import { buildSchema, graphql, parse, subscribe } from "graphql";
import type { WebSocket } from "ws";
import { z } from "zod";
import { escrowDeltaFeed, type EscrowDelta } from "../lib/escrow-deltas.js";
import type { EventStore } from "../lib/stellar-event-store.js";

const schema = buildSchema(`
  type IndexedEscrow {
    contractId: ID!
    escrowId: ID!
    status: String!
    lockedAmount: String
    releasedAmount: String
    disputedBy: String
    lastLedger: Int!
  }
  type Query {
    indexedEscrow(contractId: ID!, escrowId: ID!): IndexedEscrow
  }
  type Subscription {
    escrowChanged(contractId: ID!, escrowId: ID!): IndexedEscrow!
  }
`);

class DeltaIterator implements AsyncIterableIterator<{ escrowChanged: EscrowDelta }> {
  private pending?: (value: IteratorResult<{ escrowChanged: EscrowDelta }>) => void;
  private queue: Array<{ escrowChanged: EscrowDelta }> = [];
  private unsubscribe: () => void;

  constructor(contractId: string, escrowId: string) {
    this.unsubscribe = escrowDeltaFeed.subscribe(contractId, escrowId, (event) => {
      const payload = { escrowChanged: event };
      if (this.pending) {
        const resolve = this.pending;
        this.pending = undefined;
        resolve({ value: payload, done: false });
      } else {
        this.queue.push(payload);
      }
    });
  }
  [Symbol.asyncIterator]() { return this; }
  next(): Promise<IteratorResult<{ escrowChanged: EscrowDelta }>> {
    const value = this.queue.shift();
    if (value) return Promise.resolve({ value, done: false });
    return new Promise((resolve) => { this.pending = resolve; });
  }
  return(): Promise<IteratorResult<{ escrowChanged: EscrowDelta }>> {
    this.unsubscribe();
    return Promise.resolve({ value: undefined, done: true });
  }
}

const bodySchema = z.object({
  query: z.string().min(1),
  variables: z.record(z.unknown()).optional(),
  operationName: z.string().optional(),
});

export async function graphqlRoutes(app: FastifyInstance, options: { store: EventStore }) {
  const root = {
    indexedEscrow: ({ contractId, escrowId }: { contractId: string; escrowId: string }) =>
      options.store.escrow(contractId, escrowId),
    escrowChanged: ({ contractId, escrowId }: { contractId: string; escrowId: string }) =>
      new DeltaIterator(contractId, escrowId),
  };

  app.post("/graphql", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ errors: [{ message: "invalid GraphQL request" }] });
    const result = await graphql({
      schema,
      source: parsed.data.query,
      rootValue: root,
      variableValues: parsed.data.variables,
      operationName: parsed.data.operationName,
    });
    return reply.code(result.errors ? 400 : 200).send(result);
  });

  app.get("/graphql", { websocket: true }, (connection: any) => {
    const socket: WebSocket = connection.socket;
    const active = new Map<string, AsyncIterator<unknown>>();
    socket.on("message", async (raw) => {
      let message: any;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === "connection_init") {
        socket.send(JSON.stringify({ type: "connection_ack" }));
        return;
      }
      if (message.type === "complete") {
        await active.get(message.id)?.return?.();
        active.delete(message.id);
        return;
      }
      if (message.type !== "subscribe" || typeof message.id !== "string") return;
      try {
        const document = parse(message.payload?.query ?? "");
        const result = await subscribe({
          schema,
          document,
          rootValue: root,
          variableValues: message.payload?.variables,
          operationName: message.payload?.operationName,
        });
        if (!(Symbol.asyncIterator in result)) {
          socket.send(JSON.stringify({ id: message.id, type: "error", payload: result.errors }));
          return;
        }
        active.set(message.id, result);
        void (async () => {
          for await (const payload of result) {
            if (socket.readyState !== socket.OPEN) break;
            socket.send(JSON.stringify({ id: message.id, type: "next", payload }));
          }
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ id: message.id, type: "complete" }));
          }
        })();
      } catch (error) {
        socket.send(JSON.stringify({ id: message.id, type: "error", payload: [{ message: String(error) }] }));
      }
    });
    socket.once("close", () => {
      for (const iterator of active.values()) void iterator.return?.();
      active.clear();
    });
  });
}
