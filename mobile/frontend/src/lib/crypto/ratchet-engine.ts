import nacl from "tweetnacl";
import type {
  DoubleRatchetHeader,
  E2EEPrekeyBundle,
  E2EEPrekeyUploadRequest,
  E2EEMessagePayload,
  X3DHSessionInit,
} from "@velo/shared";

export interface KeyPairBytes {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

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

function toBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

export function generateX25519KeyPair(): KeyPairBytes {
  const pair = nacl.box.keyPair();
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
}

export function computeX25519DH(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return nacl.scalarMult(secretKey, publicKey);
}

export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  infoStr: string,
  lengthBytes: number
): Promise<Uint8Array> {
  const textEncoder = new TextEncoder();
  const info = textEncoder.encode(infoStr);
  
  const hkdfKey = await crypto.subtle.importKey("raw", toBuffer(ikm), { name: "HKDF" }, false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBuffer(salt),
      info: toBuffer(info),
    },
    hkdfKey,
    lengthBytes * 8
  );
  return new Uint8Array(derivedBits);
}

export async function KDF_RK(rk: Uint8Array, dhOut: Uint8Array): Promise<{ RK: Uint8Array; CK: Uint8Array }> {
  const derived = await hkdfSha256(dhOut, rk, "Velo-DoubleRatchet-Root", 64);
  return {
    RK: derived.subarray(0, 32),
    CK: derived.subarray(32, 64),
  };
}

export async function KDF_CK(ck: Uint8Array): Promise<{ CK: Uint8Array; MK: Uint8Array }> {
  const derived = await hkdfSha256(new Uint8Array([0x01]), ck, "Velo-DoubleRatchet-Chain", 64);
  return {
    CK: derived.subarray(0, 32),
    MK: derived.subarray(32, 64),
  };
}

export interface ClientRatchetState {
  DHs: KeyPairBytes;
  DHr: Uint8Array | null;
  RK: Uint8Array;
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  MKSKIPPED: Map<string, Uint8Array>;
}

export function createDevicePrekeyBundle(ownAddress: string): {
  identityKey: KeyPairBytes;
  signedPrekey: { id: number; keyPair: KeyPairBytes; signature: string };
  oneTimePrekeys: Array<{ id: number; keyPair: KeyPairBytes }>;
  uploadRequest: E2EEPrekeyUploadRequest;
} {
  const identityKey = generateX25519KeyPair();
  const signedPrekeyPair = generateX25519KeyPair();
  const signedPrekey = {
    id: 1,
    keyPair: signedPrekeyPair,
    signature: toBase64(nacl.hash(signedPrekeyPair.publicKey).subarray(0, 64)),
  };

  const oneTimePrekeys: Array<{ id: number; keyPair: KeyPairBytes }> = [];
  for (let i = 1; i <= 10; i++) {
    oneTimePrekeys.push({ id: i, keyPair: generateX25519KeyPair() });
  }

  const uploadRequest: E2EEPrekeyUploadRequest = {
    address: ownAddress,
    identityPublicKey: toBase64(identityKey.publicKey),
    signedPrekey: {
      id: signedPrekey.id,
      publicKey: toBase64(signedPrekey.keyPair.publicKey),
      signature: signedPrekey.signature,
    },
    oneTimePrekeys: oneTimePrekeys.map((otp) => ({
      id: otp.id,
      publicKey: toBase64(otp.keyPair.publicKey),
    })),
  };

  return { identityKey, signedPrekey, oneTimePrekeys, uploadRequest };
}

export async function performX3DHAliceClient(
  senderAddress: string,
  ikA: KeyPairBytes,
  bundleB: E2EEPrekeyBundle
): Promise<{ masterSecret: Uint8Array; x3dhInit: X3DHSessionInit }> {
  const ekA = generateX25519KeyPair();

  const spkBPub = fromBase64(bundleB.signedPrekey.publicKey);
  const ikBPub = fromBase64(bundleB.identityPublicKey);

  const dh1 = computeX25519DH(ikA.secretKey, spkBPub);
  const dh2 = computeX25519DH(ekA.secretKey, ikBPub);
  const dh3 = computeX25519DH(ekA.secretKey, spkBPub);

  let ikmConcat = new Uint8Array(dh1.length + dh2.length + dh3.length);
  ikmConcat.set(dh1, 0);
  ikmConcat.set(dh2, dh1.length);
  ikmConcat.set(dh3, dh1.length + dh2.length);

  if (bundleB.oneTimePrekey) {
    const opkBPub = fromBase64(bundleB.oneTimePrekey.publicKey);
    const dh4 = computeX25519DH(ekA.secretKey, opkBPub);
    const combined = new Uint8Array(ikmConcat.length + dh4.length);
    combined.set(ikmConcat, 0);
    combined.set(dh4, ikmConcat.length);
    ikmConcat = combined;
  }

  const salt = new Uint8Array(32);
  const masterSecret = await hkdfSha256(ikmConcat, salt, "Velo-X3DH-v1", 32);

  const x3dhInit: X3DHSessionInit = {
    senderAddress,
    senderIdentityKey: toBase64(ikA.publicKey),
    ephemeralKey: toBase64(ekA.publicKey),
    signedPrekeyId: bundleB.signedPrekey.id,
    oneTimePrekeyId: bundleB.oneTimePrekey?.id,
  };

  return { masterSecret, x3dhInit };
}

export async function ratchetInitAliceClient(
  masterSecret: Uint8Array,
  peerDHPubB64: string
): Promise<ClientRatchetState> {
  const DHs = generateX25519KeyPair();
  const DHr = fromBase64(peerDHPubB64);
  const dhOut = computeX25519DH(DHs.secretKey, DHr);
  const { RK, CK: CKs } = await KDF_RK(masterSecret, dhOut);

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

export function ratchetInitBobClient(
  masterSecret: Uint8Array,
  bobDHKeyPair: KeyPairBytes
): ClientRatchetState {
  return {
    DHs: bobDHKeyPair,
    DHr: null,
    RK: masterSecret,
    CKs: null,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    MKSKIPPED: new Map(),
  };
}

export async function ratchetEncryptClient(
  state: ClientRatchetState,
  plaintextBytes: Uint8Array
): Promise<{ header: DoubleRatchetHeader; ciphertext: string; nonce: string }> {
  if (!state.CKs) throw new Error("Uninitialized sending chain");

  const { CK, MK } = await KDF_CK(state.CKs);
  state.CKs = CK;

  const header: DoubleRatchetHeader = {
    dhPub: toBase64(state.DHs.publicKey),
    n: state.Ns,
    pn: state.PN,
  };
  state.Ns += 1;

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey("raw", toBuffer(MK), { name: "AES-GCM" }, false, ["encrypt"]);
  const encryptedBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toBuffer(nonce) }, aesKey, toBuffer(plaintextBytes));

  return {
    header,
    ciphertext: toBase64(new Uint8Array(encryptedBuf)),
    nonce: toBase64(nonce),
  };
}

export async function ratchetDecryptClient(
  state: ClientRatchetState,
  header: DoubleRatchetHeader,
  ciphertextB64: string,
  nonceB64: string
): Promise<Uint8Array> {
  const nonce = fromBase64(nonceB64);
  const fullCiphertext = fromBase64(ciphertextB64);

  const dhPubBytes = fromBase64(header.dhPub);

  // DH Ratchet step if remote DH pubkey changed
  if (!state.DHr || toBase64(state.DHr) !== header.dhPub) {
    state.PN = state.Ns;
    state.Ns = 0;
    state.Nr = 0;
    state.DHr = dhPubBytes;

    const dhOut1 = computeX25519DH(state.DHs.secretKey, state.DHr);
    const { RK: rk1, CK: ckr } = await KDF_RK(state.RK, dhOut1);
    state.RK = rk1;
    state.CKr = ckr;

    state.DHs = generateX25519KeyPair();
    const dhOut2 = computeX25519DH(state.DHs.secretKey, state.DHr);
    const { RK: rk2, CK: cks } = await KDF_RK(state.RK, dhOut2);
    state.RK = rk2;
    state.CKs = cks;
  }

  if (!state.CKr) throw new Error("Uninitialized receiving chain");

  const { CK, MK } = await KDF_CK(state.CKr);
  state.CKr = CK;
  state.Nr += 1;

  const aesKey = await crypto.subtle.importKey("raw", toBuffer(MK), { name: "AES-GCM" }, false, ["decrypt"]);
  const decryptedBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toBuffer(nonce) }, aesKey, toBuffer(fullCiphertext));

  return new Uint8Array(decryptedBuf);
}

export async function computeSafetyNumberClient(pubKeyA: string, pubKeyB: string): Promise<string> {
  const bufA = fromBase64(pubKeyA);
  const bufB = fromBase64(pubKeyB);
  const [first, second] = [bufA, bufB].sort((a, b) => toBase64(a).localeCompare(toBase64(b)));
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toBuffer(combined)));
  const hex = Array.from(digest.subarray(0, 6))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`.toUpperCase();
}
