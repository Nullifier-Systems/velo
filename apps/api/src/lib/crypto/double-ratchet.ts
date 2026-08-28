import cryptoModule from "node:crypto";
import type { DoubleRatchetHeader } from "@velo/shared";
import {
  generateX25519KeyPair,
  computeX25519DH,
  hkdfSha256,
  type KeyPairB64,
} from "./x3dh.js";

const MAX_SKIP = 2000;

export interface RatchetState {
  DHs: KeyPairB64;
  DHr: string | null; // base64 remote DH pubkey
  RK: Buffer;         // Root Key (32 bytes)
  CKs: Buffer | null; // Sending Chain Key (32 bytes)
  CKr: Buffer | null; // Receiving Chain Key (32 bytes)
  Ns: number;         // Message index in sending chain
  Nr: number;         // Message index in receiving chain
  PN: number;         // Count of messages in previous sending chain
  MKSKIPPED: Map<string, Buffer>; // Skipped message keys keyed by `${DHr}:${n}`
}

/** Root Key KDF: derives new Root Key and Chain Key from previous RK and DH shared secret */
export function KDF_RK(rk: Buffer, dhOut: Buffer): { RK: Buffer; CK: Buffer } {
  const derived = hkdfSha256(dhOut, rk, "Velo-DoubleRatchet-Root", 64);
  return {
    RK: derived.subarray(0, 32),
    CK: derived.subarray(32, 64),
  };
}

/** Chain Key KDF: derives new Chain Key and Message Key from current Chain Key */
export function KDF_CK(ck: Buffer): { CK: Buffer; MK: Buffer } {
  const derived = hkdfSha256(Buffer.from([0x01]), ck, "Velo-DoubleRatchet-Chain", 64);
  return {
    CK: derived.subarray(0, 32),
    MK: derived.subarray(32, 64),
  };
}

/** Initializes Double Ratchet state for Alice (initiator) */
export function ratchetInitAlice(sharedMasterSecret: Buffer, bobDHPubB64: string): RatchetState {
  const DHs = generateX25519KeyPair();
  const DHr = bobDHPubB64;
  const dhOut = computeX25519DH(DHs.secretKey, DHr);
  const { RK, CK: CKs } = KDF_RK(sharedMasterSecret, dhOut);

  return {
    DHs,
    DHr,
    RK,
    CKs,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    MKSKIPPED: new Map(),
  };
}

/** Initializes Double Ratchet state for Bob (receiver) */
export function ratchetInitBob(sharedMasterSecret: Buffer, bobDHKeyPair: KeyPairB64): RatchetState {
  return {
    DHs: bobDHKeyPair,
    DHr: null,
    RK: sharedMasterSecret,
    CKs: null,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    MKSKIPPED: new Map(),
  };
}

/** Encrypts plaintext using AES-256-GCM with a unique 96-bit nonce and advances sending chain */
export function ratchetEncrypt(
  state: RatchetState,
  plaintext: string | Buffer,
  AD?: Buffer
): { header: DoubleRatchetHeader; ciphertext: string; nonce: string } {
  if (!state.CKs) {
    throw new Error("Ratchet state sending chain key (CKs) is uninitialized");
  }

  const { CK, MK } = KDF_CK(state.CKs);
  state.CKs = CK;

  const header: DoubleRatchetHeader = {
    dhPub: state.DHs.publicKey,
    n: state.Ns,
    pn: state.PN,
  };

  state.Ns += 1;

  // Generate random 96-bit (12-byte) nonce
  const nonceBuf = cryptoModule.randomBytes(12);
  const cipher = cryptoModule.createCipheriv("aes-256-gcm", MK, nonceBuf);
  
  if (AD) cipher.setAAD(AD);
  
  const ptBuf = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const encrypted = Buffer.concat([cipher.update(ptBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  // Ciphertext includes payload + 16-byte auth tag
  const ciphertextBuf = Buffer.concat([encrypted, tag]);

  return {
    header,
    ciphertext: ciphertextBuf.toString("base64"),
    nonce: nonceBuf.toString("base64"),
  };
}

/** Skips message keys in current receiving chain up to untilN */
function skipMessageKeys(state: RatchetState, untilN: number): void {
  if (!state.CKr || !state.DHr) return;

  if (state.Nr + MAX_SKIP < untilN) {
    throw new Error("Too many skipped messages in Double Ratchet stream");
  }

  while (state.Nr < untilN) {
    const { CK, MK } = KDF_CK(state.CKr);
    state.CKr = CK;
    state.MKSKIPPED.set(`${state.DHr}:${state.Nr}`, MK);
    state.Nr += 1;
  }
}

/** Performs a DH Ratchet step when receiving a message with a new remote DH public key */
function dhRatchetStep(state: RatchetState, remoteDHPub: string): void {
  state.PN = state.Ns;
  state.Ns = 0;
  state.Nr = 0;
  state.DHr = remoteDHPub;

  const dhOut1 = computeX25519DH(state.DHs.secretKey, state.DHr);
  const { RK: rk1, CK: ckr } = KDF_RK(state.RK, dhOut1);
  state.RK = rk1;
  state.CKr = ckr;

  state.DHs = generateX25519KeyPair();
  const dhOut2 = computeX25519DH(state.DHs.secretKey, state.DHr);
  const { RK: rk2, CK: cks } = KDF_RK(state.RK, dhOut2);
  state.RK = rk2;
  state.CKs = cks;
}

/** Decrypts an incoming message payload using Double Ratchet state */
export function ratchetDecrypt(
  state: RatchetState,
  header: DoubleRatchetHeader,
  ciphertextB64: string,
  nonceB64: string,
  AD?: Buffer
): Buffer {
  const nonceBuf = Buffer.from(nonceB64, "base64");
  const fullCipherBuf = Buffer.from(ciphertextB64, "base64");

  if (fullCipherBuf.length < 16) {
    throw new Error("Ciphertext too short to contain AES-GCM authentication tag");
  }

  const ciphertextBuf = fullCipherBuf.subarray(0, fullCipherBuf.length - 16);
  const tagBuf = fullCipherBuf.subarray(fullCipherBuf.length - 16);

  // 1. Check skipped keys map first
  const skipKey = `${header.dhPub}:${header.n}`;
  if (state.MKSKIPPED.has(skipKey)) {
    const mk = state.MKSKIPPED.get(skipKey)!;
    state.MKSKIPPED.delete(skipKey);

    const decipher = cryptoModule.createDecipheriv("aes-256-gcm", mk, nonceBuf);
    if (AD) decipher.setAAD(AD);
    decipher.setAuthTag(tagBuf);
    return Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]);
  }

  // 2. Perform DH ratchet step if remote DH pubkey changed
  if (header.dhPub !== state.DHr) {
    skipMessageKeys(state, header.pn);
    dhRatchetStep(state, header.dhPub);
  }

  // 3. Skip message keys in current receiving chain up to header.n
  skipMessageKeys(state, header.n);

  if (!state.CKr) {
    throw new Error("Ratchet state receiving chain key (CKr) is uninitialized");
  }

  // 4. Derive message key for header.n
  const { CK, MK } = KDF_CK(state.CKr);
  state.CKr = CK;
  state.Nr += 1;

  // 5. Decrypt payload
  const decipher = cryptoModule.createDecipheriv("aes-256-gcm", MK, nonceBuf);
  if (AD) decipher.setAAD(AD);
  decipher.setAuthTag(tagBuf);

  return Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]);
}

/** Computes short 12-char fingerprint (safety number) from two base64 public keys */
export function computeSafetyNumber(pubKeyA: string, pubKeyB: string): string {
  const bufA = Buffer.from(pubKeyA, "base64");
  const bufB = Buffer.from(pubKeyB, "base64");
  const [first, second] = [bufA, bufB].sort((a, b) => a.compare(b));
  
  const hash = cryptoModule.createHash("sha256").update(Buffer.concat([first, second])).digest();
  const hex = hash.subarray(0, 6).toString("hex").toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/** Verifies two safety number fingerprints in constant-time to avoid timing attacks */
export function verifySafetyNumberConstantTime(fingerprintA: string, fingerprintB: string): boolean {
  const bufA = Buffer.from(fingerprintA, "utf8");
  const bufB = Buffer.from(fingerprintB, "utf8");
  if (bufA.length !== bufB.length) return false;
  return cryptoModule.timingSafeEqual(bufA, bufB);
}
