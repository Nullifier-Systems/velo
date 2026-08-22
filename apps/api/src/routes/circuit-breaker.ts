import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../lib/errors.js";
import { requireAdminApiKeyHeader } from "../lib/admin-auth.js";
import { CircuitBreakerStore, CircuitBreakerOverrideService } from "../lib/circuit-breaker-store.js";
import { broadcastCircuitBreakerPause } from "../lib/stellar.js";

/**
 * POST /api/v1/admin/circuit-breaker/override (#374)
 *
 * Authenticated manual override of the automated circuit-breaker arbitration
 * engine. The handler:
 *   1. Validates the admin `x-admin-api-key` (admin-auth.ts).
 *   2. Zod-validates the payload (contractId / action / reason).
 *   3. Acquires a pessimistic `SELECT ... FOR UPDATE` on `system_invariant_state`.
 *   4. Signs and broadcasts the Soroban pause/unpause via the session-account
 *      emergency key (stellar.ts -> contracts/session-account).
 *   5. Commits the status transition + audit incident synchronously and
 *      returns HTTP 200 with the on-chain tx hash.
 */
export const CircuitBreakerOverrideSchema = z.object({
  contractId: z.string().length(56, "Invalid Stellar contract address"),
  action: z.enum(["FORCE_PAUSE", "UNPAUSE"]),
  reason: z.string().min(10, "Override reason must be detailed"),
});

export type CircuitBreakerOverrideBody = z.infer<typeof CircuitBreakerOverrideSchema>;

export interface CircuitBreakerRoutesOptions {
  store?: CircuitBreakerStore;
  /** Overridable in tests — broadcasts the pause on-chain. */
  broadcast?: (params: { contractId: string; action: "FORCE_PAUSE" | "UNPAUSE" }) => Promise<{ hash: string }>;
}

export async function circuitBreakerRoutes(app: FastifyInstance, opts: CircuitBreakerRoutesOptions = {}) {
  const store = opts.store ?? new CircuitBreakerStore((app as any).pg);
  const overrideService = new CircuitBreakerOverrideService(store);
  const broadcast =
    opts.broadcast ??
    ((params: { contractId: string; action: "FORCE_PAUSE" | "UNPAUSE" }) =>
      broadcastCircuitBreakerPause(params, app.log));

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireAdminApiKeyHeader(req);
    } catch (error) {
      if (error instanceof ApiError) return reply.status(error.statusCode).send(error.toJSON(req.id));
      throw error;
    }
  });

  app.post<{ Body: CircuitBreakerOverrideBody }>(
    "/admin/circuit-breaker/override",
    async (req, reply) => {
      const parsed = CircuitBreakerOverrideSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", {
          detail: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
      }
      const { contractId, action, reason } = parsed.data;
      const operatorName = String(req.headers["x-admin-operator-name"] ?? "System Admin");

      // 1. Pessimistic lock + conflict detection (SELECT ... FOR UPDATE).
      const outcome = await overrideService.apply({ contractId, action, reason, txPauseHash: null });
      if (!outcome.state) {
        throw new ApiError(404, "NOT_FOUND", "Contract not found in invariant state.");
      }
      if (!outcome.applied) {
        throw new ApiError(
          409,
          "STATE_ALREADY_SET",
          `Contract status is already set to ${outcome.conflictStatus}.`,
        );
      }

      // 2. Session-account emergency sign + on-chain broadcast.
      let broadcastResult: { hash: string };
      try {
        broadcastResult = await broadcast({ contractId, action });
      } catch (error) {
        req.log.error(error, "circuit-breaker override on-chain broadcast failed");
        throw new ApiError(502, "TX_SUBMIT_FAILED", "On-chain pause/unpause broadcast failed", {
          detail: String(error),
        });
      }

      // 3. Audit the incident with the confirmed tx hash, idempotently.
      const incidentId = await store.logIncident({
        contractId,
        violatedInvariant: `ADMIN_OVERRIDE:${action}`,
        evidence: { reason, action, operator: operatorName },
        actionTaken: action === "FORCE_PAUSE" ? "PAUSE_SINGLE_ESCROW" : "NO_ACTION",
        txPauseHash: broadcastResult.hash,
      });

      return reply.status(200).send({
        status: "success",
        contractId,
        action,
        newStatus: action === "FORCE_PAUSE" ? "HALTED" : "HEALTHY",
        txHash: broadcastResult.hash,
        incidentId,
      });
    },
  );

  // GET /admin/circuit-breaker/incidents — incident history for the dashboard.
  app.get<{ Querystring: { contractId?: string } }>(
    "/admin/circuit-breaker/incidents",
    async (req, reply) => {
      const incidents = await store.incidents(req.query.contractId);
      return reply.status(200).send({ status: "success", count: incidents.length, data: incidents });
    },
  );

  // GET /admin/circuit-breaker/state — current invariant state snapshot.
  app.get<{ Querystring: { contractId?: string } }>(
    "/admin/circuit-breaker/state",
    async (req, reply) => {
      const contractId = req.query.contractId;
      if (!contractId) {
        return reply.status(200).send({ status: "success", data: [] });
      }
      const state = await store.get(contractId);
      if (!state) {
        return reply.status(200).send({ status: "success", data: null });
      }
      return reply.status(200).send({
        status: "success",
        data: {
          contractId: state.contractId,
          totalLockedStroops: state.totalLockedStroops.toString(),
          totalAllocatedStroops: state.totalAllocatedStroops.toString(),
          feeAccumulatorStroops: state.feeAccumulatorStroops.toString(),
          lastProcessedLedger: state.lastProcessedLedger,
          status: state.status,
        },
      });
    },
  );
}
