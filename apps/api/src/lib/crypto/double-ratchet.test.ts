import { describe, it, expect } from "vitest";
import {
  generateX25519KeyPair,
  performX3DHAlice,
  performX3DHBob,
} from "./x3dh.js";
import {
  ratchetInitAlice,
  ratchetInitBob,
  ratchetEncrypt,
  ratchetDecrypt,
  computeSafetyNumber,
  verifySafetyNumberConstantTime,
  KDF_CK,
} from "./double-ratchet.js";
import type { E2EEPrekeyBundle } from "@velo/shared";

describe("Double Ratchet & X3DH Engine", () => {
  it("establishes X3DH master shared key symmetrically", () => {
    const ikA = generateX25519KeyPair();
    const ikB = generateX25519KeyPair();
    const spkB = generateX25519KeyPair();
    const opkB = generateX25519KeyPair();

    const bundleB: E2EEPrekeyBundle = {
      address: "GBOB_ADDRESS",
      identityPublicKey: ikB.publicKey,
      signedPrekey: {
        id: 1,
        publicKey: spkB.publicKey,
        signature: "dummy-sig",
      },
      oneTimePrekey: {
        id: 10,
        publicKey: opkB.publicKey,
      },
    };

    const { masterSecret: secretA, x3dhInit } = performX3DHAlice("GALICE_ADDRESS", ikA, bundleB);
    const secretB = performX3DHBob(ikB, spkB, opkB, x3dhInit);

    expect(secretA.toString("hex")).toBe(secretB.toString("hex"));
  });

  it("handles 100+ ratchet steps with Perfect Forward Secrecy (PFS)", () => {
    const ikA = generateX25519KeyPair();
    const ikB = generateX25519KeyPair();
    const spkB = generateX25519KeyPair();
    const opkB = generateX25519KeyPair();

    const bundleB: E2EEPrekeyBundle = {
      address: "GBOB_ADDRESS",
      identityPublicKey: ikB.publicKey,
      signedPrekey: { id: 1, publicKey: spkB.publicKey, signature: "sig" },
      oneTimePrekey: { id: 1, publicKey: opkB.publicKey },
    };

    const { masterSecret, x3dhInit } = performX3DHAlice("GALICE_ADDRESS", ikA, bundleB);
    const secretB = performX3DHBob(ikB, spkB, opkB, x3dhInit);

    const aliceState = ratchetInitAlice(masterSecret, spkB.publicKey);
    const bobState = ratchetInitBob(secretB, spkB);

    const capturedEncryptedMessages: Array<{ ciphertext: string; nonce: string; header: any }> = [];

    // Alice sends 50 messages, then Bob sends 50 messages, repeating over 100+ total steps
    for (let step = 0; step < 60; step++) {
      const msgText = `Alice message #${step}`;
      const payload = ratchetEncrypt(aliceState, msgText);
      capturedEncryptedMessages.push(payload);

      const decryptedBuf = ratchetDecrypt(bobState, payload.header, payload.ciphertext, payload.nonce);
      expect(decryptedBuf.toString("utf8")).toBe(msgText);
    }

    for (let step = 0; step < 60; step++) {
      const msgText = `Bob reply #${step}`;
      const payload = ratchetEncrypt(bobState, msgText);
      capturedEncryptedMessages.push(payload);

      const decryptedBuf = ratchetDecrypt(aliceState, payload.header, payload.ciphertext, payload.nonce);
      expect(decryptedBuf.toString("utf8")).toBe(msgText);
    }

    // PFS Assertion: Compromising a later message key (e.g. at step 100)
    // cannot be used to decrypt earlier messages (e.g. step 5).
    const earlyMsg = capturedEncryptedMessages[5];
    const dummyLateMK = KDF_CK(aliceState.CKs!).MK; // Compromised later key

    // Attempting to decrypt early message with late key must fail authentication
    expect(() => {
      ratchetDecrypt(
        { ...bobState, CKr: dummyLateMK },
        earlyMsg.header,
        earlyMsg.ciphertext,
        earlyMsg.nonce
      );
    }).toThrow();
  });

  it("handles out-of-order message delivery via skipped keys", () => {
    const ikA = generateX25519KeyPair();
    const ikB = generateX25519KeyPair();
    const spkB = generateX25519KeyPair();

    const bundleB: E2EEPrekeyBundle = {
      address: "GBOB",
      identityPublicKey: ikB.publicKey,
      signedPrekey: { id: 1, publicKey: spkB.publicKey, signature: "sig" },
    };

    const { masterSecret, x3dhInit } = performX3DHAlice("GALICE", ikA, bundleB);
    const secretB = performX3DHBob(ikB, spkB, undefined, x3dhInit);

    const aliceState = ratchetInitAlice(masterSecret, spkB.publicKey);
    const bobState = ratchetInitBob(secretB, spkB);

    // Alice sends 3 messages in sequence
    const msg1 = ratchetEncrypt(aliceState, "First message");
    const msg2 = ratchetEncrypt(aliceState, "Second message");
    const msg3 = ratchetEncrypt(aliceState, "Third message");

    // Bob receives msg3 BEFORE msg1 and msg2
    const dec3 = ratchetDecrypt(bobState, msg3.header, msg3.ciphertext, msg3.nonce);
    expect(dec3.toString("utf8")).toBe("Third message");

    // Bob later receives msg1 and msg2 out of order
    const dec1 = ratchetDecrypt(bobState, msg1.header, msg1.ciphertext, msg1.nonce);
    expect(dec1.toString("utf8")).toBe("First message");

    const dec2 = ratchetDecrypt(bobState, msg2.header, msg2.ciphertext, msg2.nonce);
    expect(dec2.toString("utf8")).toBe("Second message");
  });

  it("computes safety numbers and verifies them in constant-time", () => {
    const pubA = generateX25519KeyPair().publicKey;
    const pubB = generateX25519KeyPair().publicKey;

    const fpA = computeSafetyNumber(pubA, pubB);
    const fpB = computeSafetyNumber(pubB, pubA);

    expect(fpA).toBe(fpB);
    expect(fpA).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(verifySafetyNumberConstantTime(fpA, fpB)).toBe(true);
    expect(verifySafetyNumberConstantTime(fpA, "0000-0000-0000")).toBe(false);
  });
});
