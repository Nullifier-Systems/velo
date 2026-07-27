import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../lib/errors.js";
import {
  ALLOWED_EVIDENCE_TYPES,
  getDisputeEvidence,
  getDisputeEvidenceForTrade,
  MAX_EVIDENCE_BYTES,
  saveDisputeEvidence,
  type DisputeEvidenceRecord,
} from "../lib/dispute-evidence-store.js";
import { getCashRequest } from "../lib/store.js";

interface EvidenceHeaders {
  "content-type"?: string;
  "x-file-name"?: string;
  "x-stellar-address"?: string;
}

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
  };
}

function hasValidImageSignature(contentType: string, data: Buffer): boolean {
  if (contentType === "image/jpeg") return data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (contentType === "image/png") return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return data.length >= 12
    && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP";
}

export async function disputeEvidenceRoutes(app: FastifyInstance) {
  for (const contentType of ALLOWED_EVIDENCE_TYPES) {
    if (!app.hasContentTypeParser(contentType)) {
      app.addContentTypeParser(contentType, { parseAs: "buffer", bodyLimit: MAX_EVIDENCE_BYTES }, (_request, body, done) => {
        done(null, body);
      });
    }
  }

  app.post<{ Params: { id: string }; Headers: EvidenceHeaders; Body: Buffer }>(
    "/cash/request/:id/evidence",
    async (request, reply) => {
      const access = participantForTrade(request);
      if (access.trade.status !== "disputed") {
        throw new ApiError(409, "CONFLICT", "Evidence can only be uploaded for disputed trades.");
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
      const record = saveDisputeEvidence({
        tradeId: access.trade.id,
        uploadedBy: access.participant,
        fileName,
        contentType,
        data: request.body,
      });

      if ((app as any).pg) {
        await (app as any).pg.query(
          `INSERT INTO dispute_evidence
             (id, trade_id, uploaded_by, file_name, content_type, size_bytes, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [record.id, record.tradeId, record.uploadedBy, record.fileName, record.contentType,
            record.sizeBytes, record.data, record.createdAt],
        );
      }

      return reply.code(201).send(metadata(record));
    },
  );

  app.get<{ Params: { id: string }; Headers: EvidenceHeaders }>(
    "/cash/request/:id/evidence",
    async (request) => {
      const access = participantForTrade(request);
      if ((app as any).pg) {
        const { rows } = await (app as any).pg.query(
          `SELECT id, trade_id AS "tradeId", uploaded_by AS "uploadedBy", file_name AS "fileName",
                  content_type AS "contentType", size_bytes AS "sizeBytes", created_at AS "createdAt"
           FROM dispute_evidence WHERE trade_id = $1 ORDER BY created_at`,
          [access.trade.id],
        );
        return { data: rows };
      }
      return { data: getDisputeEvidenceForTrade(access.trade.id).map(metadata) };
    },
  );

  app.get<{ Params: { id: string; evidenceId: string }; Headers: EvidenceHeaders }>(
    "/cash/request/:id/evidence/:evidenceId",
    async (request, reply) => {
      const access = participantForTrade(request);
      if ((app as any).pg) {
        const { rows } = await (app as any).pg.query(
          `SELECT file_name, content_type, data FROM dispute_evidence WHERE id = $1 AND trade_id = $2`,
          [request.params.evidenceId, access.trade.id],
        );
        if (!rows[0]) throw new ApiError(404, "EVIDENCE_NOT_FOUND", "Evidence not found.");
        const safeName = String(rows[0].file_name).replace(/[\"\r\n]/g, "_");
        return reply.type(rows[0].content_type).header("content-disposition", `inline; filename="${safeName}"`).send(rows[0].data);
      }
      const evidence = getDisputeEvidence(request.params.evidenceId);
      if (!evidence || evidence.tradeId !== access.trade.id) {
        throw new ApiError(404, "EVIDENCE_NOT_FOUND", "Evidence not found.");
      }
      return reply.type(evidence.contentType).header("content-disposition", `inline; filename="${evidence.fileName}"`).send(evidence.data);
    },
  );
}

export { metadata as disputeEvidenceMetadata };
