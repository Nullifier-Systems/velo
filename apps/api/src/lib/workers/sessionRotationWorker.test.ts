import { describe, expect, it, vi } from "vitest";
import { SESSION_ROTATION_DLQ, SESSION_ROTATION_GROUP, SESSION_ROTATION_QUEUE } from "@velo/shared";
import { MemorySessionKeyRegistryStore } from "../session-registry-store.js";
import {
  startSessionRotationWorker,
  type SessionRotationMessage,
  type SessionRotationWorkerEvent,
} from "./sessionRotationWorker.js";

vi.mock("../stellar.js", () => ({ getRotationProposal: vi.fn() }));

const OLD_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NEW_KEY = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

async function seed(): Promise<{ store: MemorySessionKeyRegistryStore; message: SessionRotationMessage }> {
  const store = new MemorySessionKeyRegistryStore();
  await store.registerKey({ pubkey: OLD_KEY, spendingQuota: 1_000n });
  const proposal = await store.createProposal({
    oldPubkey: OLD_KEY,
    newPubkey: NEW_KEY,
    signer1: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  });
  return {
    store,
    message: {
      proposalId: proposal.proposalId,
      oldSessionPubkey: OLD_KEY,
      newSessionPubkey: NEW_KEY,
      onchainProposalId: "7",
    },
  };
}

function waitFor(
  events: SessionRotationWorkerEvent[],
  type: SessionRotationWorkerEvent["type"],
): Promise<SessionRotationWorkerEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = setInterval(() => {
      const found = events.find((event) => event.type === type);
      if (found) {
        clearInterval(poll);
        resolve(found);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`no ${type} event within 5s`));
      }
    }, 5);
  });
}

describe("session rotation worker (#375)", () => {
  it("revokes the old key once the rotation is confirmed on-chain", async () => {
    const { store, message } = await seed();
    const events: SessionRotationWorkerEvent[] = [];
    const stop = startSessionRotationWorker({
      store,
      queue: [message],
      pollIntervalMs: 1,
      baseDelayMs: 1,
      confirmRotation: async () => true,
      onEvent: (event) => events.push(event),
    });

    const confirmed = await waitFor(events, "confirmed");
    stop();

    expect(confirmed).toMatchObject({ proposalId: message.proposalId, attempts: 1 });
    expect((await store.getKey(OLD_KEY))?.status).toBe("REVOKED");
    expect((await store.getProposal(message.proposalId))?.executed).toBe(true);
  });

  it("retries five times with backoff then dead-letters the proposal", async () => {
    const { store, message } = await seed();
    const events: SessionRotationWorkerEvent[] = [];
    const dlq: SessionRotationMessage[] = [];
    const confirmRotation = vi.fn().mockRejectedValue(new Error("rpc down"));
    const stop = startSessionRotationWorker({
      store,
      queue: [message],
      dlq,
      pollIntervalMs: 1,
      baseDelayMs: 1,
      random: () => 0.5,
      confirmRotation,
      onEvent: (event) => events.push(event),
    });

    await waitFor(events, "dead-letter");
    stop();

    expect(confirmRotation).toHaveBeenCalledTimes(5);
    expect(events.filter((event) => event.type === "retry")).toHaveLength(5);
    expect(dlq).toEqual([message]);
    expect((await store.getKey(OLD_KEY))?.status).toBe("ACTIVE");
    expect((await store.getProposal(message.proposalId))?.executed).toBe(false);
  });

  it("reads, acks and dead-letters through redis streams", async () => {
    const { store, message } = await seed();
    const events: SessionRotationWorkerEvent[] = [];
    const acked: string[] = [];
    const added: Array<{ key: string; message: Record<string, string> }> = [];
    let delivered = false;

    const redis = {
      xGroupCreate: vi.fn().mockResolvedValue("OK"),
      xReadGroup: vi.fn().mockImplementation(async () => {
        if (delivered) return null;
        delivered = true;
        return [
          {
            name: SESSION_ROTATION_QUEUE,
            messages: [
              {
                id: "1-0",
                message: {
                  proposalId: message.proposalId,
                  oldSessionPubkey: OLD_KEY,
                  newSessionPubkey: NEW_KEY,
                  onchainProposalId: "7",
                },
              },
            ],
          },
        ];
      }),
      xAck: vi.fn().mockImplementation(async (_key: string, _group: string, id: string) => {
        acked.push(id);
        return 1;
      }),
      xAdd: vi.fn().mockImplementation(async (key: string, _id: string, fields: Record<string, string>) => {
        added.push({ key, message: fields });
        return "1-0";
      }),
    };

    const stop = startSessionRotationWorker({
      store,
      redis,
      pollIntervalMs: 1,
      baseDelayMs: 1,
      maxAttempts: 2,
      random: () => 0,
      confirmRotation: async () => false,
      onEvent: (event) => events.push(event),
    });

    await waitFor(events, "dead-letter");
    stop();

    expect(redis.xGroupCreate).toHaveBeenCalledWith(
      SESSION_ROTATION_QUEUE,
      SESSION_ROTATION_GROUP,
      "0",
      { MKSTREAM: true },
    );
    expect(acked).toEqual(["1-0"]);
    expect(added).toHaveLength(1);
    expect(added[0].key).toBe(SESSION_ROTATION_DLQ);
    expect(added[0].message.proposalId).toBe(message.proposalId);
  });
});
