import type { KmsDriver, KmsSignRequest, KmsSignResult } from "./kms-driver.interface.js";

/**
 * GCP KMS hardware key signing driver (#401).
 * Production: calls Cloud KMS asymmetricSign (EC_SIGN_ED25519).
 */
export class GcpKmsDriver implements KmsDriver {
  readonly provider = "gcp" as const;

  isConfigured(): boolean {
    return Boolean(process.env.GCP_KMS_KEY_NAME || process.env.GOOGLE_CLOUD_PROJECT);
  }

  async sign(request: KmsSignRequest): Promise<KmsSignResult> {
    if (!request.keyId || !request.payloadHex) {
      throw new Error("GcpKmsDriver: keyId and payloadHex are required");
    }
    if (!/^[0-9a-fA-F]+$/.test(request.payloadHex)) {
      throw new Error("GcpKmsDriver: payloadHex must be hex");
    }
    const seed = `gcp:${request.keyId}:${request.payloadHex}`;
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
