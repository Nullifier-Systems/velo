import nacl from "tweetnacl";

/**
 * Client-side end-to-end encryption for trade chat.
 *
 * Each device generates its own X25519 keypair (independent of the user's
 * Stellar Ed25519 signing key, which the app has no access to client-side
 * yet — see docs/trade-chat-e2e-encryption.md). Messages are sealed with
 * NaCl `box` (X25519 + XSalsa20-Poly1305) so the backend only ever sees
 * ciphertext.
 */

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface EncryptedMessage {
  ciphertext: string;
  nonce: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function storageKey(ownAddress: string): string {
  return `velo:e2e:${ownAddress}`;
}

function peerPinKey(tradeId: string): string {
  return `velo:e2e:peer:${tradeId}`;
}

/** Loads this device's X25519 keypair for `ownAddress`, generating and persisting one if absent. */
export function getOrCreateKeyPair(ownAddress: string): KeyPair {
  const key = storageKey(ownAddress);
  const stored = localStorage.getItem(key);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { publicKey: string; secretKey: string };
      return { publicKey: fromBase64(parsed.publicKey), secretKey: fromBase64(parsed.secretKey) };
    } catch {
      // fall through and regenerate a fresh keypair below
    }
  }

  const pair = nacl.box.keyPair();
  localStorage.setItem(
    key,
    JSON.stringify({ publicKey: toBase64(pair.publicKey), secretKey: toBase64(pair.secretKey) })
  );
  return pair;
}

export function encryptMessage(plaintext: string, peerPublicKey: Uint8Array, ownSecretKey: Uint8Array): EncryptedMessage {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const sealed = nacl.box(textEncoder.encode(plaintext), nonce, peerPublicKey, ownSecretKey);
  return { ciphertext: toBase64(sealed), nonce: toBase64(nonce) };
}

/** Returns null if the ciphertext is malformed or fails authentication (tampered/wrong key). */
export function decryptMessage(ciphertext: string, nonce: string, peerPublicKey: Uint8Array, ownSecretKey: Uint8Array): string | null {
  try {
    const opened = nacl.box.open(fromBase64(ciphertext), fromBase64(nonce), peerPublicKey, ownSecretKey);
    return opened ? textDecoder.decode(opened) : null;
  } catch {
    return null;
  }
}

/** Short, order-independent fingerprint of both participants' public keys for out-of-band verification. */
export async function computeSafetyNumber(publicKeyA: Uint8Array, publicKeyB: Uint8Array): Promise<string> {
  const [first, second] = [publicKeyA, publicKeyB].sort((a, b) => toBase64(a).localeCompare(toBase64(b)));
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
  const hex = Array.from(digest.slice(0, 6))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`.toUpperCase();
}

export function getPinnedPeerKey(tradeId: string): string | null {
  return localStorage.getItem(peerPinKey(tradeId));
}

export function setPinnedPeerKey(tradeId: string, publicKey: string): void {
  localStorage.setItem(peerPinKey(tradeId), publicKey);
}
