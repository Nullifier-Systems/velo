import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { e2eeKeysRoutes } from "./e2ee-keys.js";
import { clearPrekeyVault } from "../lib/crypto/prekey-vault.js";
import { generateX25519KeyPair } from "../lib/crypto/x3dh.js";

const VALID_ADDRESS = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("E2EE Prekey Routes (/api/v1/e2ee/keys/*)", () => {
  let app: any;

  beforeEach(async () => {
    clearPrekeyVault();
    app = Fastify();
    await app.register(e2eeKeysRoutes, { prefix: "/api/v1" });
  });

  it("uploads a prekey bundle and fetches it successfully", async () => {
    const ik = generateX25519KeyPair();
    const spk = generateX25519KeyPair();
    const otp1 = generateX25519KeyPair();
    const otp2 = generateX25519KeyPair();

    const uploadRes = await app.inject({
      method: "POST",
      url: "/api/v1/e2ee/keys/upload",
      payload: {
        address: VALID_ADDRESS,
        identityPublicKey: ik.publicKey,
        signedPrekey: { id: 1, publicKey: spk.publicKey, signature: "valid-dummy-sig-12345" },
        oneTimePrekeys: [
          { id: 101, publicKey: otp1.publicKey },
          { id: 102, publicKey: otp2.publicKey },
        ],
      },
    });

    expect(uploadRes.statusCode).toBe(200);
    const uploadBody = uploadRes.json();
    expect(uploadBody.success).toBe(true);
    expect(uploadBody.uploadedOneTimePrekeysCount).toBe(2);

    // Fetch bundle 1 -> should return otp1
    const fetchRes1 = await app.inject({
      method: "GET",
      url: `/api/v1/e2ee/keys/bundle/${VALID_ADDRESS}`,
    });
    expect(fetchRes1.statusCode).toBe(200);
    const bundle1 = fetchRes1.json().bundle;
    expect(bundle1.address).toBe(VALID_ADDRESS);
    expect(bundle1.identityPublicKey).toBe(ik.publicKey);
    expect(bundle1.oneTimePrekey).toMatchObject({ id: 101, publicKey: otp1.publicKey });

    // Fetch bundle 2 -> should consume and return otp2
    const fetchRes2 = await app.inject({
      method: "GET",
      url: `/api/v1/e2ee/keys/bundle/${VALID_ADDRESS}`,
    });
    expect(fetchRes2.statusCode).toBe(200);
    const bundle2 = fetchRes2.json().bundle;
    expect(bundle2.oneTimePrekey).toMatchObject({ id: 102, publicKey: otp2.publicKey });

    // Fetch bundle 3 -> one-time prekeys exhausted, returns bundle without oneTimePrekey
    const fetchRes3 = await app.inject({
      method: "GET",
      url: `/api/v1/e2ee/keys/bundle/${VALID_ADDRESS}`,
    });
    expect(fetchRes3.statusCode).toBe(200);
    const bundle3 = fetchRes3.json().bundle;
    expect(bundle3.oneTimePrekey).toBeUndefined();
  });

  it("rejects upload with malformed address or missing keys", async () => {
    const badAddressRes = await app.inject({
      method: "POST",
      url: "/api/v1/e2ee/keys/upload",
      payload: {
        address: "INVALID_ADDR",
        identityPublicKey: generateX25519KeyPair().publicKey,
        signedPrekey: { id: 1, publicKey: generateX25519KeyPair().publicKey, signature: "sig" },
        oneTimePrekeys: [],
      },
    });
    expect(badAddressRes.statusCode).toBe(400);

    const missingSignedPrekeyRes = await app.inject({
      method: "POST",
      url: "/api/v1/e2ee/keys/upload",
      payload: {
        address: VALID_ADDRESS,
        identityPublicKey: generateX25519KeyPair().publicKey,
        oneTimePrekeys: [],
      },
    });
    expect(missingSignedPrekeyRes.statusCode).toBe(400);
  });

  it("returns 404 when fetching a bundle for an unknown address", async () => {
    const unknownRes = await app.inject({
      method: "GET",
      url: `/api/v1/e2ee/keys/bundle/${VALID_ADDRESS}`,
    });
    expect(unknownRes.statusCode).toBe(404);
  });
});
