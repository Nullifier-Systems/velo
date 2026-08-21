import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ApiError } from "../../lib/errors.js";
import { MemorySessionKeyRegistryStore } from "../../lib/session-registry-store.js";

vi.mock("../../lib/stellar.js", () => ({
  proposeRotation: vi.fn(),
  approveRotation: vi.fn(),
  getRotationProposal: vi.fn(),
}));

import { approveRotation, proposeRotation } from "../../lib/stellar.js";
import {
  rotationPayload,
  sessionRotationRoutes,
  type SessionRotationQueueMessage,
} from "../session-rotation.js";

/**
 * The API validates addresses with the repo-wide `/^G[1-9A-HJ-NP-Za-km-z]{55}$/`
 * (session.ts, provider.ts, ...). That character class is base58, while Stellar
 * strkeys are base32, so only ~4% of real keypairs satisfy it — these fixtures
 * are seeded deterministically until they do.
 */
const ACCEPTED_ADDRESS = /^G[1-9A-HJ-NP-Za-km-z]{55}$/;

function seededKeypair(index: number): Keypair {
  const seed = Buffer.alloc(32);
  for (let n = index * 1_000; n < index * 1_000 + 10_000; n += 1) {
    seed.writeUInt32BE(n, 0);
    const keypair = Keypair.fromRawEd25519Seed(seed);
    if (ACCEPTED_ADDRESS.test(keypair.publicKey())) return keypair;
  }
  throw new Error(`no address matching the API regex for seed ${index}`);
}

const adminA = seededKeypair(1);
const adminB = seededKeypair(2);
const outsider = seededKeypair(3);
const OLD_KEY = seededKeypair(4).publicKey();
const NEW_KEY = seededKeypair(5).publicKey();
const OTHER_KEY = seededKeypair(6).publicKey();
const UNKNOWN_KEY = seededKeypair(7).publicKey();
const QUOTA = 1_000_000n;

function sign(signer: Keypair, oldKey = OLD_KEY, newKey = NEW_KEY): string {
  return signer.sign(Buffer.from(rotationPayload(oldKey, newKey), "utf8")).toString("hex");
}

async function buildApp(store: MemorySessionKeyRegistryStore, enqueued: SessionRotationQueueMessage[]) {
  const app = Fastify();
  // Mirror app.ts so the tests assert the flat ApiError body that ships.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send(error.toJSON(request.id as string));
    }
    return reply.send(error);
  });
  await app.register(sessionRotationRoutes, {
    prefix: "/api/v1",
    store,
    enqueue: async (message: SessionRotationQueueMessage) => {
      enqueued.push(message);
    },
  });
  await app.ready();
  return app;
}

describe("session-key multi-sig rotation endpoints (#375)", () => {
  let store: MemorySessionKeyRegistryStore;
  let enqueued: SessionRotationQueueMessage[];

  beforeEach(async () => {
    process.env.SESSION_ROTATION_ADMIN_KEYS = `${adminA.publicKey()}, ${adminB.publicKey()}`;
    process.env.SESSION_ACCOUNT_CONTRACT_ID = "C".padEnd(56, "a");
    store = new MemorySessionKeyRegistryStore();
    enqueued = [];
    await store.registerKey({ pubkey: OLD_KEY, spendingQuota: QUOTA });
    vi.mocked(proposeRotation).mockResolvedValue(7n);
    vi.mocked(approveRotation).mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.SESSION_ROTATION_ADMIN_KEYS;
    delete process.env.SESSION_ACCOUNT_CONTRACT_ID;
    vi.clearAllMocks();
  });

  function rotatePayload(signer: Keypair = adminA) {
    return {
      oldSessionPubkey: OLD_KEY,
      newSessionPubkey: NEW_KEY,
      signerPublicKey: signer.publicKey(),
      signature: sign(signer),
    };
  }

  it("accepts the first admin signature and locks the key into ROTATING", async () => {
    const app = await buildApp(store, enqueued);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key",
      payload: rotatePayload(),
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body).toMatchObject({
      status: "ROTATING",
      signatures_collected: 1,
      required_signatures: 2,
    });
    expect(body.proposal_id).toEqual(expect.any(String));
    expect((await store.getKey(OLD_KEY))?.status).toBe("ROTATING");
    expect(enqueued).toEqual([
      { proposalId: body.proposal_id, oldSessionPubkey: OLD_KEY, newSessionPubkey: NEW_KEY },
    ]);
    await app.close();
  });

  it("rejects a signature from a key outside the admin set (401)", async () => {
    const app = await buildApp(store, enqueued);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key",
      payload: rotatePayload(outsider),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("INVALID_MULTISIG_SIGNATURE");
    expect(response.json().error).toBe(
      "Signature verification failed against admin threshold key set.",
    );
    expect((await store.getKey(OLD_KEY))?.status).toBe("ACTIVE");
    await app.close();
  });

  it("rejects an admin signature over a different payload (401)", async () => {
    const app = await buildApp(store, enqueued);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key",
      payload: {
        ...rotatePayload(),
        signature: sign(adminA, OLD_KEY, OTHER_KEY),
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("INVALID_MULTISIG_SIGNATURE");
    await app.close();
  });

  it("rejects a malformed body (400)", async () => {
    const app = await buildApp(store, enqueued);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key",
      payload: { ...rotatePayload(), oldSessionPubkey: "not-a-key" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("returns 404 for a key that is not registered", async () => {
    const app = await buildApp(store, enqueued);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key",
      payload: {
        oldSessionPubkey: UNKNOWN_KEY,
        newSessionPubkey: NEW_KEY,
        signerPublicKey: adminA.publicKey(),
        signature: sign(adminA, UNKNOWN_KEY, NEW_KEY),
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("NOT_FOUND");
    await app.close();
  });

  it("returns 409 KEY_ALREADY_INACTIVE for a ROTATING or REVOKED key", async () => {
    const app = await buildApp(store, enqueued);

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key",
      payload: rotatePayload(),
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key",
      payload: rotatePayload(adminB),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("KEY_ALREADY_INACTIVE");
    expect(second.json().error).toBe(
      "Target session key is already revoked or undergoing rotation.",
    );

    await store.markRevoked(OLD_KEY);
    const third = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key",
      payload: rotatePayload(),
    });
    expect(third.statusCode).toBe(409);
    expect(third.json().code).toBe("KEY_ALREADY_INACTIVE");
    await app.close();
  });

  it("reaches the 2-of-3 threshold with a second distinct admin", async () => {
    const app = await buildApp(store, enqueued);
    const proposalId = (
      await app.inject({
        method: "POST",
        url: "/api/v1/session/rotate-key",
        payload: rotatePayload(),
      })
    ).json().proposal_id as string;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key/approve",
      payload: {
        proposalId,
        signerPublicKey: adminB.publicKey(),
        signature: sign(adminB),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      proposal_id: proposalId,
      status: "ROTATING",
      signatures_collected: 2,
      required_signatures: 2,
      onchain_proposal_id: "7",
    });
    expect(proposeRotation).toHaveBeenCalledWith({
      contractId: process.env.SESSION_ACCOUNT_CONTRACT_ID,
      proposer: adminA.publicKey(),
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
    });
    expect(approveRotation).toHaveBeenCalledWith({
      contractId: process.env.SESSION_ACCOUNT_CONTRACT_ID,
      approver: adminB.publicKey(),
      proposalId: 7n,
    });
    expect((await store.getProposal(proposalId))?.signer2).toBe(adminB.publicKey());
    await app.close();
  });

  it("refuses a second signature from the same admin (401)", async () => {
    const app = await buildApp(store, enqueued);
    const proposalId = (
      await app.inject({
        method: "POST",
        url: "/api/v1/session/rotate-key",
        payload: rotatePayload(),
      })
    ).json().proposal_id as string;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key/approve",
      payload: {
        proposalId,
        signerPublicKey: adminA.publicKey(),
        signature: sign(adminA),
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("INVALID_MULTISIG_SIGNATURE");
    expect(proposeRotation).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 502 when the on-chain rotation call fails", async () => {
    vi.mocked(proposeRotation).mockRejectedValue(new Error("rpc down"));
    const app = await buildApp(store, enqueued);
    const proposalId = (
      await app.inject({
        method: "POST",
        url: "/api/v1/session/rotate-key",
        payload: rotatePayload(),
      })
    ).json().proposal_id as string;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key/approve",
      payload: {
        proposalId,
        signerPublicKey: adminB.publicKey(),
        signature: sign(adminB),
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("TX_SUBMIT_FAILED");
    await app.close();
  });

  it("returns 404 for an unknown proposal", async () => {
    const app = await buildApp(store, enqueued);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key/approve",
      payload: {
        proposalId: "11111111-2222-4333-8444-555555555555",
        signerPublicKey: adminB.publicKey(),
        signature: sign(adminB),
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("NOT_FOUND");
    await app.close();
  });

  it("refuses spending against a rotating or revoked key (store level)", async () => {
    const app = await buildApp(store, enqueued);
    expect(await store.reserveSpend(OLD_KEY, 10n)).toMatchObject({ ok: true });

    await app.inject({
      method: "POST",
      url: "/api/v1/session/rotate-key",
      payload: rotatePayload(),
    });
    expect(await store.reserveSpend(OLD_KEY, 10n)).toMatchObject({
      ok: false,
      reason: "NOT_ACTIVE",
      status: "ROTATING",
    });

    await store.markRevoked(OLD_KEY);
    expect(await store.reserveSpend(OLD_KEY, 10n)).toMatchObject({
      ok: false,
      reason: "NOT_ACTIVE",
      status: "REVOKED",
    });
    expect((await store.getKey(OLD_KEY))?.spentQuota).toBe(10n);
    await app.close();
  });
});
