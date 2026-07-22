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
  createdAt: string;
}

const evidenceStore = new Map<string, DisputeEvidenceRecord>();

export function saveDisputeEvidence(
  evidence: Omit<DisputeEvidenceRecord, "id" | "createdAt" | "sizeBytes">,
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

export function getDisputeEvidence(id: string): DisputeEvidenceRecord | undefined {
  return evidenceStore.get(id);
}

export function getDisputeEvidenceForTrade(tradeId: string): DisputeEvidenceRecord[] {
  return Array.from(evidenceStore.values())
    .filter(record => record.tradeId === tradeId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function clearDisputeEvidence(): void {
  evidenceStore.clear();
}
