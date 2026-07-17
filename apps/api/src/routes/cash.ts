 import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CONTRACTS } from "@velo/shared";
import { lockEscrow, releaseEscrow } from "../lib/stellar.js";
import { randomHex32 } from "../lib/crypto.js";
import { saveCashRequest, getCashRequest, updateStatus } from "../lib/store.js";
import { parseBody } from "../lib/validation.js";

const ESCROW_CONTRACT_ID = process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow;
const DEFAULT_TIMEOUT_LEDGERS = 100; // ~15-20 min at Stellar's ~5-6s ledger close time

const cashRequestSchema = z.object({
  seller: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  buyer: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  amount_stroops: z.string().trim().min(1).regex(/^\d+$/),
  secret_hash: z.string().trim().length(64).regex(/^[0-9a-fA-F]+$/),
});

type CashRequestBody = z.infer<typeof cashRequestSchema>;

/**
 * GET  /api/v1/cash/agents        — find nearby cash providers ($0.001)
 * POST /api/v1/cash/request       — lock funds via the escrow contract,
 *                                    return a claim_url + QR payload ($0.01)
 * GET  /api/v1/cash/request/:id   — poll a pending cash request (free)
 * POST /api/v1/cash/request/:id/release — merchant confirms hand-off,
 *                                    releases escrow using the secret
 *                                    embedded in the scanned QR (free —
 *                                    this is a state-transition call, not
 *                                    a discovery/search call)
 */
export async function cashRoutes(app: FastifyInstance) {
  app.get("/cash/agents", async (req, reply) => {
    const paid = await (app as any).requirePayment(req, reply, "0.001");
    if (!paid) return;

    // TODO: query a real merchant registry (on-chain reputation + off-chain
    // location index). Stub data below for local dev only.
    return {
      agents: [{ name: "Farmacia Guadalupe", distance_km: 0.3, tier: "Maestro" }],
    };
  });

  app.post<{ Body: CashRequestBody }>("/cash/request", async (req, reply) => {
    const paid = await (app as any).requirePayment(req, reply, "0.01");
    if (!paid) return;

    const body = parseBody(cashRequestSchema, req.body, reply);
    if (!body) return;

    const { seller, buyer, amount_stroops, secret_hash } = body;

    const tradeId = randomHex32();

    try {
      await lockEscrow({
        contractId: ESCROW_CONTRACT_ID,
        tradeId,
        seller,
        buyer,
        amountStroops: BigInt(amount_stroops),
        secretHashHex: secret_hash,
        timeoutLedgers: DEFAULT_TIMEOUT_LEDGERS,
      });
    } catch (err) {
      req.log.error(err, "lockEscrow failed");
      reply.code(502).send({
        error: "escrow lock failed",
        detail: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return;
    }
    saveCashRequest({
      id: tradeId,
      contractId: ESCROW_CONTRACT_ID,
      seller,
      buyer,
      amountStroops: amount_stroops,
      secretHex: "", // The API no longer knows the secret
      secretHashHex: secret_hash,
      status: "locked",
      createdAt: new Date().toISOString(),
    });

    const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
    reply.code(201).send({
      // The secret is held client-side and is NOT returned by the API
      claim_url: `${baseUrl}/claim/${tradeId}`,
      qr_payload: `velo://claim?request_id=${tradeId}&contract=${ESCROW_CONTRACT_ID}`,
      instructions: "Show this QR to the cash provider to receive your cash.",
    });
  });

  app.get<{ Params: { id: string } }>("/cash/request/:id", async (req, reply) => {
    const record = getCashRequest(req.params.id);
    if (!record) {
      reply.code(404).send({ error: "request not found" });
      return;
    }
    const { secretHex: _omit, ...safe } = record;
    return safe;
  });

  app.post<{ Params: { id: string }; Body: { secret: string } }>(
    "/cash/request/:id/release",
    async (req, reply) => {
      const record = getCashRequest(req.params.id);
      if (!record) {
        reply.code(404).send({ error: "request not found" });
        return;
      }
      if (record.status !== "locked") {
        reply.code(409).send({ error: `request is already ${record.status}` });
        return;
      }

      const releaseBody = parseBody(
        z.object({ secret: z.string().trim().min(1) }),
        req.body,
        reply
      );
      if (!releaseBody) return;

      const { secret } = releaseBody;

      try {
        await releaseEscrow({
          contractId: record.contractId,
          tradeId: record.id,
          secretHex: secret,
        });
      } catch (err) {
        req.log.error(err, "releaseEscrow failed");
        reply.code(502).send({ error: "escrow release failed", detail: String(err) });
        return;
      }

      updateStatus(record.id, "released");
      return { id: record.id, status: "released" };
    }
  );
}