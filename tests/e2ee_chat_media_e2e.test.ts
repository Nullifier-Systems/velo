import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { chatRoutes } from "../apps/api/src/routes/chat.js";
import { e2eeKeysRoutes } from "../apps/api/src/routes/e2ee-keys.js";
import { issueChatCapability } from "../apps/api/src/lib/chat-capability.js";
import { MemoryChatInfrastructure } from "../apps/api/src/lib/chat-infrastructure.js";
import { getMessages, clearChatStore } from "../apps/api/src/lib/chat-store.js";
import { clearPrekeyVault, savePrekeyBundle } from "../apps/api/src/lib/crypto/prekey-vault.js";
import {
  generateX25519KeyPair,
  performX3DHAlice,
  performX3DHBob,
} from "../apps/api/src/lib/crypto/x3dh.js";
import {
  ratchetInitAlice,
  ratchetInitBob,
  ratchetEncrypt,
  ratchetDecrypt,
} from "../apps/api/src/lib/crypto/double-ratchet.js";
import type { E2EEPrekeyBundle } from "@velo/shared";

const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB   = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TRADE_ID = "trade-e2ee-media-roundtrip";

function nextFrame(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for frame ${type}`)), 3_000);
    const handler = (raw: WebSocket.RawData) => {
      const payload = JSON.parse(raw.toString());
      if (payload.type === type) {
        clearTimeout(timeout);
        socket.off("message", handler);
        resolve(payload);
      }
    };
    socket.on("message", handler);
    socket.once("error", reject);
  });
}

describe("E2EE Chat & 64KB Media Chunk End-to-End Test", () => {
  let infrastructure: MemoryChatInfrastructure;
  let app: any;
  let serverPort: number;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    clearChatStore();
    clearPrekeyVault();
    infrastructure = new MemoryChatInfrastructure();
    process.env.CHAT_CAPABILITY_SECRET = "test-chat-capability-secret-at-least-32-bytes";
    await infrastructure.putTrade(TRADE_ID, { buyer: ALICE, seller: BOB, status: "locked" });

    app = Fastify();
    await app.register(websocket);
    await app.register(e2eeKeysRoutes, { prefix: "/api/v1" });
    await app.register(chatRoutes, { prefix: "/api/v1", infrastructure });
    await app.listen({ port: 0 });
    serverPort = (app.server.address() as any).port;
  });

  afterEach(async () => {
    for (const s of sockets) s.terminate();
    await app.close();
  });

  it("performs full X3DH handshake, text chat, and 64KB encrypted media chunk roundtrip with server blind relay", async () => {
    // 1. Generate & Upload Bob's Prekey Bundle
    const ikB = generateX25519KeyPair();
    const spkB = generateX25519KeyPair();
    const opkB = generateX25519KeyPair();

    const uploadBobRes = await app.inject({
      method: "POST",
      url: "/api/v1/e2ee/keys/upload",
      payload: {
        address: BOB,
        identityPublicKey: ikB.publicKey,
        signedPrekey: { id: 1, publicKey: spkB.publicKey, signature: Buffer.alloc(64).toString("base64") },
        oneTimePrekeys: [{ id: 10, publicKey: opkB.publicKey }],
      },
    });
    expect(uploadBobRes.statusCode).toBe(200);

    // 2. Alice fetches Bob's Prekey Bundle from API
    const fetchBundleRes = await app.inject({
      method: "GET",
      url: `/api/v1/e2ee/keys/bundle/${BOB}`,
    });
    expect(fetchBundleRes.statusCode).toBe(200);
    const bundleB: E2EEPrekeyBundle = fetchBundleRes.json().bundle;

    // 3. Alice performs X3DH key exchange & initial Double Ratchet setup
    const ikA = generateX25519KeyPair();
    const { masterSecret: aliceMasterSecret, x3dhInit } = performX3DHAlice(ALICE, ikA, bundleB);
    const aliceRatchet = ratchetInitAlice(aliceMasterSecret, bundleB.signedPrekey.publicKey);

    // 4. Bob receives X3DH init & initializes receiving Double Ratchet state
    const bobMasterSecret = performX3DHBob(ikB, spkB, opkB, x3dhInit);
    const bobRatchet = ratchetInitBob(bobMasterSecret, spkB);

    // 5. Connect Alice and Bob WebSockets
    const aliceToken = issueChatCapability(TRADE_ID, ALICE);
    const bobToken = issueChatCapability(TRADE_ID, BOB);

    const aliceSocket = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/chat/${TRADE_ID}?token=${aliceToken}`);
    const bobSocket = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/chat/${TRADE_ID}?token=${bobToken}`);
    sockets.push(aliceSocket, bobSocket);

    await nextFrame(aliceSocket, "joined");
    await nextFrame(bobSocket, "joined");

    // 6. Alice encrypts and sends a sensitive text message fixture
    const SECRET_TEXT_FIXTURE = "SECRET_CASH_HANDOFF_AT_COFFEE_SHOP_LOCATION_998877";
    const textPayload = ratchetEncrypt(aliceRatchet, SECRET_TEXT_FIXTURE);

    const bobReceiveTextPromise = nextFrame(bobSocket, "message");
    aliceSocket.send(
      JSON.stringify({
        type: "message",
        data: {
          header: textPayload.header,
          ciphertext: textPayload.ciphertext,
          nonce: textPayload.nonce,
          x3dhInit,
        },
      })
    );

    const bobTextMsgFrame = await bobReceiveTextPromise;
    expect(bobTextMsgFrame.data.ciphertext).toBe(textPayload.ciphertext);

    // Bob decrypts text message using Double Ratchet state
    const decryptedTextBuf = ratchetDecrypt(
      bobRatchet,
      bobTextMsgFrame.data.header,
      bobTextMsgFrame.data.ciphertext,
      bobTextMsgFrame.data.nonce
    );
    expect(decryptedTextBuf.toString("utf8")).toBe(SECRET_TEXT_FIXTURE);

    // 7. Alice encrypts and sends a 64KB (65,536 bytes) image chunk fixture
    const SECRET_IMAGE_FIXTURE = Buffer.alloc(64 * 1024, 0x42); // 64KB filled with 0x42
    SECRET_IMAGE_FIXTURE.write("SECRET_IMAGE_HEADER_MAGIC_BYTES_12345", 0, "utf8");

    const imagePayload = ratchetEncrypt(aliceRatchet, SECRET_IMAGE_FIXTURE);

    const bobReceiveImagePromise = nextFrame(bobSocket, "message");
    aliceSocket.send(
      JSON.stringify({
        type: "message",
        data: {
          header: imagePayload.header,
          ciphertext: imagePayload.ciphertext,
          nonce: imagePayload.nonce,
        },
      })
    );

    const bobImageMsgFrame = await bobReceiveImagePromise;
    const decryptedImageBuf = ratchetDecrypt(
      bobRatchet,
      bobImageMsgFrame.data.header,
      bobImageMsgFrame.data.ciphertext,
      bobImageMsgFrame.data.nonce
    );

    expect(decryptedImageBuf.length).toBe(64 * 1024);
    expect(decryptedImageBuf.toString("utf8", 0, 37)).toBe("SECRET_IMAGE_HEADER_MAGIC_BYTES_12345");

    // 8. CRITICAL SECURITY ASSERTIONS: Verify Server-Side Blindness
    // Inspect memory chat infrastructure store directly
    const storedMessages = await infrastructure.getMessages(TRADE_ID);
    expect(storedMessages.length).toBeGreaterThanOrEqual(2);

    for (const serverMsg of storedMessages) {
      // Assert server stored ciphertext DOES NOT contain plaintext substrings
      expect(serverMsg.ciphertext).not.toContain(SECRET_TEXT_FIXTURE);
      expect(serverMsg.ciphertext).not.toContain("SECRET_CASH_HANDOFF");
      expect(serverMsg.ciphertext).not.toContain("SECRET_IMAGE_HEADER_MAGIC_BYTES");
      
      // Assert no private keys or secret material are attached
      expect(serverMsg).not.toHaveProperty("secretKey");
      expect(serverMsg).not.toHaveProperty("privateKey");
      expect(serverMsg).not.toHaveProperty("masterSecret");
    }
  });
});
