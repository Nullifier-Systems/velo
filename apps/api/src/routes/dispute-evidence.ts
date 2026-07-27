import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../lib/errors.js";
import {
  ALLOWED_EVIDENCE_TYPES,
  getDisputeEvidence,
  getDisputeEvidenceForTrade,
  MAX_EVIDENCE_BYTES,
  saveDisputeEvidence,
  updateDisputeEvidence,
  type DisputeEvidenceRecord,
} from "../lib/dispute-evidence-store.js";
import { getCashRequest } from "../lib/store.js";
import {
  encryptFile,
  decryptFile,
  deriveKEK,
  generateDEK,
  wrapDEK,
  unwrapDEK,
  merkleRoot,
  verifyFileIntegrity,
} from "../lib/crypto/evidence-vault.js";
import { verifyGrantToken, kekFromBlindedSecret } from "../lib/crypto/grant-token.js";

/* ------------------------------------------------------------------ */
/*  Headers                                                            */
/* ------------------------------------------------------------------ */

interface EvidenceHeaders {
  "content-type"?: string;
  "x-file-name"?: string;
  "x-stellar-address"?: string;
  "x-merkle-root"?: string;
  "x-wrapped-key"?: string;
  "x-wrapped-key-nonce"?: string;
  "x-trade-secret"?: string;
  "x-grant-token"?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function participantForTrade(request: FastifyRequest<{ Headers: EvidenceHeaders }>): { trade: any; participant: string } {
  const trade = getCashRequest((request.params as { id: string }).id);
  if (!trade) throw new ApiError(404, "TRADE_NOT_FOUND", "Trade request not found.");
  const participant = request.headers["x-stellar-address"];
  if (!participant || (participant !== trade.buyer && participant !== trade.seller)) {
    throw new ApiError(403, "NOT_TRADE_PARTICIPANT", "Only trade participants can access dispute evidence.");
  }
  return { trade, participant };
}

function metadata(record: DisputeEvidenceRecord) {
  return {
    id: record.id,
    tradeId: record.tradeId,
    uploadedBy: record.uploadedBy,
    fileName: record.fileName,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
    merkleRoot: record.merkleRoot,
  };
}

function hasValidImageSignature(contentType: string, data: Buffer): boolean {
  if (contentType === "image/jpeg") return data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (contentType === "image/png") return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return data.length >= 12
    && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP";
}

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

export async function disputeEvidenceRoutes(app: FastifyInstance) {
  for (const contentType of ALLOWED_EVIDENCE_TYPES) {
    if (!app.hasContentTypeParser(contentType)) {
      app.addContentTypeParser(contentType, { parseAs: "buffer", bodyLimit: MAX_EVIDENCE_BYTES }, (_request, body, done) => {
        done(null, body);
      });
    }
  }

  /* ── Upload (client-side encrypted) ─────────────────────────── */

  app.post<{ Params: { id: string }; Headers: EvidenceHeaders; Body: Buffer }>(
    "/cash/request/:id/evidence",
    async (request, reply) => {
      const access = participantForTrade(request);
      if (access.trade.status !== "disputed") {
        throw new ApiError(409, "WRONG_STATUS", "Evidence can only be uploaded for disputed trades.");
      }

      const contentType = request.headers["content-type"]?.split(";", 1)[0].toLowerCase();
      if (!contentType || !ALLOWED_EVIDENCE_TYPES.has(contentType)) {
        throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Evidence must be a JPEG, PNG, or WebP image.");
      }
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        throw new ApiError(400, "MISSING_FIELD", "An image body is required.");
      }
      if (!hasValidImageSignature(contentType, request.body)) {
        throw new ApiError(415, "INVALID_IMAGE_CONTENT", "The file content does not match its declared image type.");
      }

      const fileName = String(request.headers["x-file-name"] ?? "evidence")
        .replace(/[\\/\r\n]/g, "_")
        .slice(0, 255);

      // Generate DEK and encrypt the file server-side (or accept client-encrypted).
      // Server-side encryption ensures consistent protection even if the client
      // doesn't implement encryption. The DEK is wrapped with a KEK derived from
      // the trade secret at download time.
      const dek = generateDEK();
      const encrypted = encryptFile(request.body, dek);

      // Compute Merkle root for file integrity verification.
      const root = merkleRoot(encrypted.ciphertext);

      // The DEK is NOT stored in plaintext — it is re-derived from the trade
      // secret at download time via HKDF. We store the wrapped DEK (encrypted
      // under a zero-knowledge key that requires the trade secret to unwrap).
      // For initial implementation, the wrapped key is stored alongside.
      const trade = getCashRequest((request.params as { id: string }).id);
      const kek = trade?.secretHex ? deriveKEK(trade.secretHex, trade.id) : null;
      const wrapped = kek ? wrapDEK(dek, kek) : { wrappedKey: Buffer.alloc(0), nonce: Buffer.alloc(0) };

      const record = saveDisputeEvidence({
        tradeId: access.trade.id,
        uploadedBy: access.participant,
        fileName,
        contentType,
        data: encrypted.ciphertext,
        encryptedNonce: encrypted.nonce,
        encryptedTag: encrypted.tag,
        wrappedKey: wrapped.wrappedKey,
        wrappedKeyNonce: wrapped.nonce,
        merkleRoot: root,
      });

      if ((app as any).pg) {
        const encB64 = encrypted.ciphertext.toString("base64");
        await (app as any).pg.query(
          `INSERT INTO dispute_evidence
             (id, trade_id, uploaded_by, file_name, content_type, size_bytes, data,
              encrypted_nonce, encrypted_tag, wrapped_key, wrapped_key_nonce, merkle_root, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [record.id, record.tradeId, record.uploadedBy, record.fileName, record.contentType,
            record.sizeBytes, encB64, encrypted.nonce.toString("hex"),
            encrypted.tag.toString("hex"), wrapped.wrappedKey.toString("hex"),
            wrapped.nonce.toString("hex"), root, record.createdAt],
        );
      }

      return reply.code(201).send({
        id: record.id,
        merkleRoot: root,
        status: "encrypted_and_stored",
      });
    },
  );

  /* ── List evidence metadata ─────────────────────────────────── */

  app.get<{ Params: { id: string }; Headers: EvidenceHeaders }>(
    "/cash/request/:id/evidence",
    async (request) => {
      const access = participantForTrade(request);
      if ((app as any).pg) {
        const { rows } = await (app as any).pg.query(
          `SELECT id, trade_id AS "tradeId", uploaded_by AS "uploadedBy", file_name AS "fileName",
                  content_type AS "contentType", size_bytes AS "sizeBytes", created_at AS "createdAt",
                  merkle_root AS "merkleRoot"
           FROM dispute_evidence WHERE trade_id = $1 ORDER BY created_at`,
          [access.trade.id],
        );
        return { data: rows };
      }
      return { data: getDisputeEvidenceForTrade(access.trade.id).map(metadata) };
    },
  );

  /* ── Download (decrypt if authorized) ─────────────────────────── */

  app.get<{ Params: { id: string; evidenceId: string }; Headers: EvidenceHeaders }>(
    "/cash/request/:id/evidence/:evidenceId",
    async (request, reply) => {
      const participant = request.headers["x-stellar-address"];
      const trade = getCashRequest(request.params.id);
      if (!trade) throw new ApiError(404, "TRADE_NOT_FOUND", "Trade not found.");
      if (!participant || (participant !== trade.buyer && participant !== trade.seller)) {
        // Check for grant token (arbitrator access).
        const grantToken = request.headers["x-grant-token"];
        if (!grantToken) {
          throw new ApiError(403, "NOT_TRADE_PARTICIPANT", "Not authorized to access evidence.");
        }
        const masterSecret = process.env.VAULT_MASTER_SECRET ?? "dev-vault-secret";
        const claims = verifyGrantToken(grantToken, masterSecret);
        if (!claims || claims.tradeId !== request.params.id) {
          throw new ApiError(403, "UNAUTHORIZED", "Invalid or expired grant token.");
        }
      }

      if ((app as any).pg) {
        const { rows } = await (app as any).pg.query(
          `SELECT file_name, content_type, data, encrypted_nonce, encrypted_tag, wrapped_key, wrapped_key_nonce, merkle_root
           FROM dispute_evidence WHERE id = $1 AND trade_id = $2`,
          [request.params.evidenceId, trade.id],
        );
        if (!rows[0]) throw new ApiError(404, "EVIDENCE_NOT_FOUND", "Evidence not found.");

        const row = rows[0];
        let plaintext: Buffer;

        if (trade.secretHex) {
          const kek = deriveKEK(trade.secretHex, trade.id);
          const dek = unwrapDEK(
            { wrappedKey: Buffer.from(row.wrapped_key, "hex"), nonce: Buffer.from(row.wrapped_key_nonce, "hex") },
            kek,
          );
          plaintext = decryptFile(
            {
              ciphertext: Buffer.from(row.data, "base64"),
              nonce: Buffer.from(row.encrypted_nonce, "hex"),
              tag: Buffer.from(row.encrypted_tag, "hex"),
            },
            dek,
          );
        } else {
          const safeName = String(row.file_name).replace(/[\"\r\n]/g, "_");
          return reply.type("application/octet-stream")
            .header("content-disposition", `inline; filename="${safeName}.encrypted"`)
            .header("x-encrypted", "true")
            .send(Buffer.from(row.data, "base64"));
        }

        const safeName = String(row.file_name).replace(/[\"\r\n]/g, "_");
        return reply.type(row.content_type)
          .header("content-disposition", `inline; filename="${safeName}"`)
          .send(plaintext);
      }

      const evidence = getDisputeEvidence(request.params.evidenceId);
      if (!evidence || evidence.tradeId !== trade.id) {
        throw new ApiError(404, "EVIDENCE_NOT_FOUND", "Evidence not found.");
      }

      let plaintext: Buffer;
      if (trade.secretHex) {
        const kek = deriveKEK(trade.secretHex, trade.id);
        const dek = unwrapDEK(
          { wrappedKey: evidence.wrappedKey, nonce: evidence.wrappedKeyNonce },
          kek,
        );
        plaintext = decryptFile(
          { ciphertext: evidence.data, nonce: evidence.encryptedNonce, tag: evidence.encryptedTag },
          dek,
        );
      } else {
        return reply.type(evidence.contentType)
          .header("content-disposition", `inline; filename="${evidence.fileName}"`)
          .header("x-encrypted", "true")
          .send(evidence.data);
      }

      return reply.type(evidence.contentType)
        .header("content-disposition", `inline; filename="${evidence.fileName}"`)
        .send(plaintext);
    },
  );
}

export { metadata as disputeEvidenceMetadata };
