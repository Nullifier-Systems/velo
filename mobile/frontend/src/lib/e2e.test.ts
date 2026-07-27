import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { encryptMessage, decryptMessage, computeSafetyNumber, toBase64, fromBase64 } from "./e2e";

describe("e2e crypto", () => {
  it("round-trips base64 encoding", () => {
    const bytes = nacl.randomBytes(32);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("encrypts and decrypts a message between two keypairs", () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();

    const { ciphertext, nonce } = encryptMessage("meet at the usual spot, 3pm", bob.publicKey, alice.secretKey);
    const plaintext = decryptMessage(ciphertext, nonce, alice.publicKey, bob.secretKey);

    expect(plaintext).toBe("meet at the usual spot, 3pm");
  });

  it("lets the sender decrypt their own message using the same shared secret", () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();

    const { ciphertext, nonce } = encryptMessage("hello", bob.publicKey, alice.secretKey);
    const ownEcho = decryptMessage(ciphertext, nonce, bob.publicKey, alice.secretKey);

    expect(ownEcho).toBe("hello");
  });

  it("fails to decrypt with the wrong key", () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const mallory = nacl.box.keyPair();

    const { ciphertext, nonce } = encryptMessage("secret", bob.publicKey, alice.secretKey);
    const result = decryptMessage(ciphertext, nonce, alice.publicKey, mallory.secretKey);

    expect(result).toBeNull();
  });

  it("fails to decrypt tampered ciphertext", () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();

    const { ciphertext, nonce } = encryptMessage("secret", bob.publicKey, alice.secretKey);
    const tampered = fromBase64(ciphertext);
    tampered[0] ^= 0xff;

    const result = decryptMessage(toBase64(tampered), nonce, alice.publicKey, bob.secretKey);
    expect(result).toBeNull();
  });

  it("computes a deterministic, order-independent safety number", async () => {
    const a = nacl.randomBytes(32);
    const b = nacl.randomBytes(32);

    const forward = await computeSafetyNumber(a, b);
    const reverse = await computeSafetyNumber(b, a);

    expect(forward).toBe(reverse);
    expect(forward).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it("produces different safety numbers for different key pairs", async () => {
    const a = nacl.randomBytes(32);
    const b = nacl.randomBytes(32);
    const c = nacl.randomBytes(32);

    const first = await computeSafetyNumber(a, b);
    const second = await computeSafetyNumber(a, c);

    expect(first).not.toBe(second);
  });
});
