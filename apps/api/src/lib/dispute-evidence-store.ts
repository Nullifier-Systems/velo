import { randomUUID } from "node:crypto";

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_EVIDENCE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface DisputeEvidenceRecord {
  id: string;
  tradeId: string;
  uploadedBy: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  data: Buffer;
  encryptedNonce: Buffer;
  encryptedTag: Buffer;
  wrappedKey: Buffer;
  wrappedKeyNonce: Buffer;
  merkleRoot: string;
  createdAt: string;
}

/** Fields required to create a new evidence record. */
export type CreateDisputeEvidenceInput = Omit<
  DisputeEvidenceRecord,
  "id" | "createdAt" | "sizeBytes"
>;

const evidenceStore = new Map<string, DisputeEvidenceRecord>();

export function saveDisputeEvidence(
  evidence: CreateDisputeEvidenceInput,
): DisputeEvidenceRecord {
  const record: DisputeEvidenceRecord = {
    ...evidence,
    id: randomUUID(),
    sizeBytes: evidence.data.byteLength,
    createdAt: new Date().toISOString(),
  };
  evidenceStore.set(record.id, record);
  return record;
}

export function updateDisputeEvidence(
  id: string,
  updates: Partial<DisputeEvidenceRecord>,
): DisputeEvidenceRecord | undefined {
  const existing = evidenceStore.get(id);
  if (!existing) return undefined;
  const updated = { ...existing, ...updates };
  evidenceStore.set(id, updated);
  return updated;
}

export function getDisputeEvidence(id: string): DisputeEvidenceRecord | undefined {
  return evidenceStore.get(id);
}

export function getDisputeEvidenceForTrade(tradeId: string): DisputeEvidenceRecord[] {
  return Array.from(evidenceStore.values())
    .filter(record => record.tradeId === tradeId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function deleteDisputeEvidenceForTrade(tradeId: string): number {
  let count = 0;
  for (const [id, record] of Array.from(evidenceStore.entries())) {
    if (record.tradeId === tradeId) {
      evidenceStore.delete(id);
      count++;
    }
  }
  return count;
}

export function clearDisputeEvidence(): void {
  evidenceStore.clear();
}
