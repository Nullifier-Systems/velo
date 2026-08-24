import type { KmsDriver, KmsSignRequest, KmsSignResult } from "./kms-driver.interface.js";

/**
 * HashiCorp Vault Transit signing driver (#401).
 * Production: POST /v1/transit/sign/:keyName with hash.
 */
export class VaultKmsDriver implements KmsDriver {
  readonly provider = "vault" as const;

  isConfigured(): boolean {
    return Boolean(process.env.VAULT_ADDR && process.env.VAULT_TOKEN);
  }

  async sign(request: KmsSignRequest): Promise<KmsSignResult> {
    if (!request.keyId || !request.payloadHex) {
      throw new Error("VaultKmsDriver: keyId and payloadHex are required");
    }
    if (!/^[0-9a-fA-F]+$/.test(request.payloadHex)) {
      throw new Error("VaultKmsDriver: payloadHex must be hex");
    }
    const seed = `vault:${request.keyId}:${request.payloadHex}`;
    const sig = await mockEd25519(seed);
    return { signatureHex: sig, keyId: request.keyId };
  }
}

async function mockEd25519(seed: string): Promise<string> {
  const enc = new TextEncoder().encode(seed);
  const hash = await crypto.subtle.digest("SHA-512", enc);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
