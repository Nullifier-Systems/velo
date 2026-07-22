import { randomUUID } from "node:crypto";

export const MAX_VERIFICATION_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const ALLOWED_VERIFICATION_DOCUMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface ProviderVerificationDocument {
  id: string;
  providerId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  data: Buffer;
  createdAt: string;
}

const documents = new Map<string, ProviderVerificationDocument>();

export function saveProviderVerificationDocument(
  document: Omit<ProviderVerificationDocument, "id" | "sizeBytes" | "createdAt">,
): ProviderVerificationDocument {
  const record = {
    ...document,
    id: randomUUID(),
    sizeBytes: document.data.byteLength,
    createdAt: new Date().toISOString(),
  };
  documents.set(record.id, record);
  return record;
}

export function getProviderVerificationDocuments(providerId: string): ProviderVerificationDocument[] {
  return Array.from(documents.values())
    .filter(document => document.providerId === providerId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function getProviderVerificationDocument(id: string): ProviderVerificationDocument | undefined {
  return documents.get(id);
}
