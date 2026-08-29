import { createHash } from "node:crypto";
import type { KmsDriver, KmsSignRequest, KmsSignResult } from "./kms-driver.interface.js";

/**
 * AWS KMS hardware key signing driver (#401).
 * In production this would call AWS KMS Sign API (ECC_ED25519).
 * Here we provide a deterministic mock that never touches cleartext keys.
 */
export class AwsKmsDriver implements KmsDriver {
  readonly provider = "aws" as const;

  isConfigured(): boolean {
    return Boolean(process.env.AWS_KMS_KEY_ID || process.env.AWS_REGION);
  }

  async sign(request: KmsSignRequest): Promise<KmsSignResult> {
    if (!request.keyId || !request.payloadHex) {
      throw new Error("AwsKmsDriver: keyId and payloadHex are required");
    }
    if (!/^[0-9a-fA-F]+$/.test(request.payloadHex)) {
      throw new Error("AwsKmsDriver: payloadHex must be hex");
    }
    // Deterministic mock: hash(payload+keyId) expanded to 64 bytes.
    // Real implementation: const cmd = new SignCommand({ KeyId, Message, MessageType:"DIGEST", SigningAlgorithm:"ECDSA_SHA_512" })
    const seed = `${request.keyId}:${request.payloadHex}`;
    const sig = mockEd25519(seed);
    return { signatureHex: sig, keyId: request.keyId };
  }
}

function mockEd25519(seed: string): string {
  return createHash("sha512").update(seed).digest("hex");
}

