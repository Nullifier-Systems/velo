import type { EncryptedMediaChunk, DoubleRatchetHeader } from "@velo/shared";

export const CHUNK_SIZE_BYTES = 64 * 1024; // 64KB chunks

export interface EncryptedChunkEnvelope {
  header: DoubleRatchetHeader;
  ciphertext: string;
  nonce: string;
}

export async function encryptMediaInChunks(
  fileData: Uint8Array,
  mimeType: string,
  encryptChunkFn: (chunkData: Uint8Array) => Promise<EncryptedChunkEnvelope>
): Promise<EncryptedMediaChunk[]> {
  const totalChunks = Math.ceil(fileData.length / CHUNK_SIZE_BYTES);
  const encryptedChunks: EncryptedMediaChunk[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE_BYTES;
    const end = Math.min(fileData.length, start + CHUNK_SIZE_BYTES);
    const chunkBytes = fileData.subarray(start, end);

    const { ciphertext, nonce } = await encryptChunkFn(chunkBytes);

    encryptedChunks.push({
      chunkIndex: i,
      totalChunks,
      ciphertext,
      nonce,
      mimeType,
    });
  }

  return encryptedChunks;
}

export async function decryptMediaChunks(
  encryptedChunks: EncryptedMediaChunk[],
  decryptChunkFn: (chunk: EncryptedMediaChunk) => Promise<Uint8Array>
): Promise<{ data: Uint8Array; mimeType: string }> {
  // Sort chunks by chunkIndex
  const sorted = [...encryptedChunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const decryptedParts: Uint8Array[] = [];
  let totalLength = 0;

  for (const chunk of sorted) {
    const bytes = await decryptChunkFn(chunk);
    decryptedParts.push(bytes);
    totalLength += bytes.length;
  }

  const assembled = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of decryptedParts) {
    assembled.set(part, offset);
    offset += part.length;
  }

  const mimeType = sorted[0]?.mimeType ?? "image/png";
  return { data: assembled, mimeType };
}
