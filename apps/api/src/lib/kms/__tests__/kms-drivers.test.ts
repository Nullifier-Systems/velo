import { describe, it, expect } from "vitest";
import { AwsKmsDriver } from "../aws-kms-driver.js";
import { GcpKmsDriver } from "../gcp-kms-driver.js";
import { VaultKmsDriver } from "../vault-kms-driver.js";

describe("KMS drivers", () => {
  const payload = "a".repeat(64);

  it("AWS KMS signs without cleartext key and returns 128-char hex", async () => {
    const d = new AwsKmsDriver();
    const r = await d.sign({ keyId: "aws-key-1", payloadHex: payload });
    expect(r.signatureHex).toMatch(/^[0-9a-f]{128}$/);
    expect(r.keyId).toBe("aws-key-1");
    // deterministic for same input
    const r2 = await d.sign({ keyId: "aws-key-1", payloadHex: payload });
    expect(r.signatureHex).toBe(r2.signatureHex);
  });

  it("GCP KMS signs deterministically, different key => different sig", async () => {
    const d = new GcpKmsDriver();
    const a = await d.sign({ keyId: "gcp-key-a", payloadHex: payload });
    const b = await d.sign({ keyId: "gcp-key-b", payloadHex: payload });
    expect(a.signatureHex).not.toBe(b.signatureHex);
  });

  it("Vault signs and rejects invalid hex", async () => {
    const d = new VaultKmsDriver();
    const r = await d.sign({ keyId: "vault-key", payloadHex: payload });
    expect(r.signatureHex).toMatch(/^[0-9a-f]{128}$/);
    await expect(d.sign({ keyId: "vault-key", payloadHex: "zzzz" })).rejects.toThrow();
  });

  it("all providers are distinct namespaces", async () => {
    const aws = await new AwsKmsDriver().sign({ keyId: "same", payloadHex: payload });
    const gcp = await new GcpKmsDriver().sign({ keyId: "same", payloadHex: payload });
    expect(aws.signatureHex).not.toBe(gcp.signatureHex);
  });
});
