import type { E2EEPrekeyBundle, X3DHSessionInit } from "@velo/shared";
import cryptoModule from "node:crypto";

export interface KeyPairB64 {
  publicKey: string; // base64
  secretKey: string; // base64
}

/** Converts base64 X25519 raw 32-byte public key to Node KeyObject */
export function importX25519PublicKey(b64: string): cryptoModule.KeyObject {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    throw new Error(`Invalid X25519 public key length: expected 32 bytes, got ${buf.length}`);
  }
  // PKCS#8 / DER header for X25519 public key (14 bytes prefix + 32 bytes raw key)
  const x25519PubHeader = Buffer.from("302a300506032b656e032100", "hex");
  const der = Buffer.concat([x25519PubHeader, buf]);
  return cryptoModule.createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Converts base64 X25519 raw 32-byte secret key to Node KeyObject */
export function importX25519SecretKey(b64: string): cryptoModule.KeyObject {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    throw new Error(`Invalid X25519 secret key length: expected 32 bytes, got ${buf.length}`);
  }
  // PKCS#8 header for X25519 private key (16 bytes prefix + 32 bytes raw key)
  const x25519PrivHeader = Buffer.from("302e020100300506032b656e04220420", "hex");
  const der = Buffer.concat([x25519PrivHeader, buf]);
  return cryptoModule.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** Generates a fresh X25519 keypair formatted as base64 raw 32-byte strings */
export function generateX25519KeyPair(): KeyPairB64 {
  const { privateKey, publicKey } = cryptoModule.generateKeyPairSync("x25519");
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  
  // Extract raw 32-byte keys from DER envelopes
  const rawPub = pubDer.subarray(pubDer.length - 32);
  const rawPriv = privDer.subarray(privDer.length - 32);

  return {
    publicKey: rawPub.toString("base64"),
    secretKey: rawPriv.toString("base64"),
  };
}

/** Computes X25519 Diffie-Hellman shared secret (32 bytes) */
export function computeX25519DH(secretKeyB64: string, publicKeyB64: string): Buffer {
  const privKeyObj = importX25519SecretKey(secretKeyB64);
  const pubKeyObj = importX25519PublicKey(publicKeyB64);
  return cryptoModule.diffieHellman({ privateKey: privKeyObj, publicKey: pubKeyObj });
}

/** Standard HKDF-SHA256 calculation */
export function hkdfSha256(ikm: Buffer, salt: Buffer, info: string, length: number): Buffer {
  return Buffer.from(cryptoModule.hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), length));
}

/**
 * Initiates an X3DH key exchange session as Alice (initiator).
 * Performs DH1, DH2, DH3 (and DH4 if Bob provided a one-time prekey).
 */
export function performX3DHAlice(
  senderAddress: string,
  ikA: KeyPairB64,
  bundleB: E2EEPrekeyBundle
): { masterSecret: Buffer; x3dhInit: X3DHSessionInit } {
  const ekA = generateX25519KeyPair();

  const dh1 = computeX25519DH(ikA.secretKey, bundleB.signedPrekey.publicKey);
  const dh2 = computeX25519DH(ekA.secretKey, bundleB.identityPublicKey);
  const dh3 = computeX25519DH(ekA.secretKey, bundleB.signedPrekey.publicKey);

  let ikm = Buffer.concat([dh1, dh2, dh3]);

  if (bundleB.oneTimePrekey) {
    const dh4 = computeX25519DH(ekA.secretKey, bundleB.oneTimePrekey.publicKey);
    ikm = Buffer.concat([ikm, dh4]);
  }

  const salt = Buffer.alloc(32, 0);
  const masterSecret = hkdfSha256(ikm, salt, "Velo-X3DH-v1", 32);

  const x3dhInit: X3DHSessionInit = {
    senderAddress,
    senderIdentityKey: ikA.publicKey,
    ephemeralKey: ekA.publicKey,
    signedPrekeyId: bundleB.signedPrekey.id,
    oneTimePrekeyId: bundleB.oneTimePrekey?.id,
  };

  return { masterSecret, x3dhInit };
}

/**
 * Responds to an X3DH key exchange session as Bob (recipient).
 * Performs DH1, DH2, DH3 (and DH4 if Bob provided a one-time prekey to Alice).
 */
export function performX3DHBob(
  ikB: KeyPairB64,
  spkB: KeyPairB64,
  opkB: KeyPairB64 | undefined,
  initA: X3DHSessionInit
): Buffer {
  const dh1 = computeX25519DH(spkB.secretKey, initA.senderIdentityKey);
  const dh2 = computeX25519DH(ikB.secretKey, initA.ephemeralKey);
  const dh3 = computeX25519DH(spkB.secretKey, initA.ephemeralKey);

  let ikm = Buffer.concat([dh1, dh2, dh3]);

  if (opkB && initA.oneTimePrekeyId !== undefined) {
    const dh4 = computeX25519DH(opkB.secretKey, initA.ephemeralKey);
    ikm = Buffer.concat([ikm, dh4]);
  }

  const salt = Buffer.alloc(32, 0);
  return hkdfSha256(ikm, salt, "Velo-X3DH-v1", 32);
}
