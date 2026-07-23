import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { refundEscrow, resolveEscrow, submitRefundTx } from "../lib/stellar.js";
import { getCashRequest, updateStatus, getAllCashRequests, getStoreStats } from "../lib/store.js";
import { notifyTradeStatus } from "./chat.js";
import {
  getRateLimitViolations,
  resolveRateLimitViolation,
} from "../lib/rate-limit-violations.js";

// Basic schema for body validation
interface FlagRequestBody {
  suspicious: boolean;
  notes?: string;
}

interface OverrideHeader {
  'x-admin-api-key': string;
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const adminKey = req.headers["x-admin-api-key"];
    const expectedKey = process.env.ADMIN_API_KEY;

    if (!expectedKey) {
      req.log.error("ADMIN_API_KEY env variable is not set!");
      return reply.status(500).send({ error: "Admin environment configuration error." });
    }

    if (!adminKey || adminKey !== expectedKey) {
      return reply.status(401).send({ error: "Unauthorized access to internal ops endpoints." });
    }
  });

  /**
   * GET /admin/stats — store-level statistics (in-memory replacement for DB query).
   */
  app.get(
    "/admin/trades",
    async (req, reply) => {
      try {
        // Replace this query logic with your actual PostgreSQL client / ORM query
        const query = `
          SELECT 
            id,
            seller as seller_address,
            buyer as buyer_address,
            amount_stroops,
            status,
            is_suspicious,
            suspicion_notes,
            flagged_at,
            created_at,
            updated_at
          FROM cash_requests
          ORDER BY created_at DESC
          LIMIT 100;
        `;
        
        let trades;
        if ((app as any).pg) {
          // --- ADAPT TO YOUR DB CLIENT ---
          const { rows } = await (app as any).pg.query(query);
          trades = rows;
        } else {
          // Fallback to in-memory store
          trades = getAllCashRequests().map(r => ({
            id: r.id,
            seller_address: r.seller,
            buyer_address: r.buyer,
            amount_stroops: r.amountStroops,
            status: r.status,
            is_suspicious: (r as any).isSuspicious ?? false,
            suspicion_notes: (r as any).suspicionNotes ?? null,
            flagged_at: (r as any).flaggedAt ?? null,
            created_at: r.createdAt,
            updated_at: r.createdAt, // Fallback
          }));
        }
        // --------------------------------

        return reply.status(200).send({
          status: "success",
          count: trades.length,
          data: trades
        });
      } catch (error) {
        req.log.error(error, "Failed to retrieve trades for admin view");
        return reply.status(500).send({ error: "Failed to load trades." });
      }
    }
  );

  app.get("/admin/rate-limit-violations", async (req, reply) => {
    try {
      let records;
      if ((app as any).pg) {
        const { rows } = await (app as any).pg.query(`
          SELECT id, identifier, route, method, occurred_at, offense_count,
                 severity, status, resolved_at, resolved_by
          FROM rate_limit_violations
          ORDER BY occurred_at DESC;
        `);
        records = rows;
      } else {
        records = getRateLimitViolations()
          .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
          .map(record => ({
            id: record.id,
            identifier: record.identifier,
            route: record.route,
            method: record.method,
            occurred_at: record.occurredAt,
            offense_count: record.offenseCount,
            severity: record.severity,
            status: record.status,
            resolved_at: record.resolvedAt,
            resolved_by: record.resolvedBy,
          }));
      }

      return reply.status(200).send({
        status: "success",
        count: records.length,
        data: records,
      });
    } catch (error) {
      req.log.error(error, "Failed to retrieve rate-limit violations");
      return reply.status(500).send({ error: "Failed to load rate-limit violations." });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/admin/rate-limit-violations/:id/resolve",
    async (req, reply) => {
      const { id } = req.params;
      const operatorName = String(req.headers["x-admin-operator-name"] || "System Admin");

      try {
        let record;
        if ((app as any).pg) {
          const { rows, rowCount } = await (app as any).pg.query(
            `
              UPDATE rate_limit_violations
              SET status = 'resolved',
                  resolved_at = COALESCE(resolved_at, NOW()),
                  resolved_by = COALESCE(resolved_by, $1)
              WHERE id = $2
              RETURNING id, identifier, route, method, occurred_at,
                        offense_count, severity, status, resolved_at, resolved_by;
            `,
            [operatorName, id],
          );
          if (rowCount === 0) {
            return reply.status(404).send({ error: "Rate-limit violation not found." });
          }
          record = rows[0];
        } else {
          const resolved = resolveRateLimitViolation(id, operatorName);
          if (!resolved) {
            return reply.status(404).send({ error: "Rate-limit violation not found." });
          }
          record = {
            id: resolved.id,
            identifier: resolved.identifier,
            route: resolved.route,
            method: resolved.method,
            occurred_at: resolved.occurredAt,
            offense_count: resolved.offenseCount,
            severity: resolved.severity,
            status: resolved.status,
            resolved_at: resolved.resolvedAt,
            resolved_by: resolved.resolvedBy,
          };
        }

        return reply.status(200).send({
          status: "success",
          message: "Rate-limit violation resolved.",
          data: record,
        });
      } catch (error) {
        req.log.error(error, `Failed to resolve rate-limit violation ${id}`);
        return reply.status(500).send({ error: "Could not resolve rate-limit violation." });
      }
    },
  );

  /**
   * POST /admin/trades/:id/flag
   * Acceptance Criteria: Ability to flag suspicious activity
   */
  app.post<{ Params: { id: string }; Body: FlagRequestBody }>(
    "/admin/trades/:id/flag",
    async (req, reply) => {
      const { id } = req.params;
      const { suspicious, notes } = req.body ?? {};

      if (typeof suspicious !== "boolean") {
        return reply.status(400).send({ error: "Field 'suspicious' (boolean) is required." });
      }

      try {
        if ((app as any).pg) {
          const query = `
            UPDATE cash_requests
            SET 
              is_suspicious = $1,
              suspicion_notes = $2,
              flagged_at = CASE WHEN $1 = TRUE THEN NOW() ELSE NULL END,
              updated_at = NOW()
            WHERE id = $3
            RETURNING id, is_suspicious, suspicion_notes, flagged_at;
          `;
          
          const { rows, rowCount } = await (app as any).pg.query(query, [suspicious, notes || null, id]);

          if (rowCount === 0) {
            return reply.status(404).send({ error: "Trade request not found." });
          }

          return reply.status(200).send({
            status: "success",
            message: suspicious ? "Trade flagged as suspicious." : "Trade suspicion flag removed.",
            data: rows[0]
          });
        } else {
          // Fallback when pg is not defined (e.g. testing)
          const record = getCashRequest(id);
          if (!record) {
            return reply.status(404).send({ error: "Trade request not found." });
          }
          (record as any).isSuspicious = suspicious;
          (record as any).suspicionNotes = notes || null;
          return reply.status(200).send({
            status: "success",
            message: suspicious ? "Trade flagged as suspicious." : "Trade suspicion flag removed.",
            data: { id, is_suspicious: suspicious, suspicion_notes: notes || null, flagged_at: suspicious ? new Date().toISOString() : null }
          });
        }
      } catch (error) {
        req.log.error(error, `Failed to flag trade ${id}`);
        return reply.status(500).send({ error: "Could not update trade flag status." });
      }
    }
  );
  app.get("/admin/stats", async (_req, reply) => {
    return reply.status(200).send(getStoreStats());
  });

  /**
   * POST /admin/trades/:id/refund — manually trigger a refund for a stuck trade.
   */
  app.post<{ Params: { id: string }; Body: { signed_xdr?: string } }>(
    "/admin/trades/:id/refund",
    async (req, reply) => {
      const { id } = req.params;
      const operatorName = req.headers["x-admin-operator-name"] || "System Admin";

      const record = getCashRequest(id);
      if (!record) {
        return reply.status(404).send({ error: "Trade request not found." });
      }

      if (record.status !== "locked") {
        return reply.status(400).send({
          error: `Cannot refund. Only locked trades can be refunded. Current status is '${record.status}'.`,
        });
      }

      try {
        req.log.warn(`Manual refund initiated for trade ID ${id} by ${operatorName}`);

        if (req.body?.signed_xdr) {
          await submitRefundTx(req.body.signed_xdr);
        } else {
          await refundEscrow({
            contractId: record.contractId,
            tradeId: record.id,
          });
        }
      } catch (err) {
        req.log.error(err, "refund on-chain call failed during admin override");
        return reply.status(502).send({
          error: "On-chain refund execution failed",
          detail: String(err),
        });
      }

      // 3. Keep DB audit trail clean & up-to-date
      try {
        if ((app as any).pg) {
          const query = `
            UPDATE cash_requests
            SET 
              status = 'refunded',
              admin_override_by = $1,
              admin_override_at = NOW(),
              updated_at = NOW()
            WHERE id = $2;
          `;
          await (app as any).pg.query(query, [operatorName, id]);
        }
        
        // Keep memory/store helper synced 
        updateStatus(id, "refunded");
        notifyTradeStatus(id, "refunded");

        return reply.status(200).send({
          status: "success",
          message: "Manual refund processed successfully.",
          trade_id: id,
          new_status: "refunded",
        });
      } catch (err) {
        req.log.error(err, "DB update failed during admin override");
        return reply.status(500).send({
          error: "Database update failed",
          detail: String(err),
        });
      }
    }
  );

  /**
   * POST /admin/trades/:id/resolve
   * Acceptance Criteria: Resolve a disputed trade.
   */
  app.post<{ Params: { id: string }; Body: { resolve_to_buyer: boolean; notes?: string } }>(
    "/admin/trades/:id/resolve",
    async (req, reply) => {
      const { id } = req.params;
      const { resolve_to_buyer, notes } = req.body ?? {};
      const operatorName = req.headers["x-admin-operator-name"] || "System Admin";

      if (typeof resolve_to_buyer !== "boolean") {
        return reply.status(400).send({ error: "Field 'resolve_to_buyer' (boolean) is required." });
      }

      // 1. Check local state store for validity
      const record = getCashRequest(id);
      if (!record) {
        return reply.status(404).send({ error: "Trade request not found." });
      }

      if (record.status !== "disputed") {
        return reply.status(400).send({
          error: `Cannot resolve. Only disputed trades can be resolved. Current status is '${record.status}'.`
        });
      }

      // 2. Perform on-chain resolution via Soroban contract calling resolve
      try {
        req.log.warn(`Admin resolution initiated on-chain for trade ID ${id} (resolve_to_buyer: ${resolve_to_buyer}) by ${operatorName}`);
        
        const adminSigners = (process.env.ADMIN_STELLAR_ADDRESSES ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      await resolveEscrow({
        contractId: record.contractId,
        tradeId: record.id,
        resolveToBuyer: resolve_to_buyer,
        signers: adminSigners,
      });

      } catch (err) {
        req.log.error(err, "resolveEscrow on-chain call failed");
        return reply.status(502).send({
          error: "On-chain resolve execution failed",
          detail: String(err)
        });
      }

      const newStatus = resolve_to_buyer ? "refunded" : "released";

      // 3. Keep DB audit trail clean & up-to-date
      try {
        if ((app as any).pg) {
          const query = `
            UPDATE cash_requests
            SET 
              status = $1,
              resolved_at = NOW(),
              resolved_by = $2,
              resolution = $3,
              updated_at = NOW()
            WHERE id = $4;
          `;
          await (app as any).pg.query(query, [newStatus, operatorName, notes || null, id]);
        }
        
        // Keep memory/store helper synced
        updateStatus(id, newStatus);
        record.resolvedAt = new Date().toISOString();
        record.resolvedBy = String(operatorName);
        record.resolution = notes || "";

        return reply.status(200).send({
          status: "success",
          message: "Dispute resolved successfully.",
          trade_id: id,
          new_status: newStatus
        });

      } catch (dbErr) {
        req.log.error(dbErr, "On-chain transaction succeeded, but internal database sync failed");
        // Keep memory/store helper synced in memory anyway
        updateStatus(id, newStatus);
        record.resolvedAt = new Date().toISOString();
        record.resolvedBy = String(operatorName);
        record.resolution = notes || "";
        
        return reply.status(500).send({
          error: "Resolution successful on-chain, but local database status sync failed. Manual sync needed.",
          trade_id: id,
          new_status: newStatus
        });
      }
    }
  );
  app.get("/admin/status", async (req, reply) => {
    return {
      ok: true,
      version: "0.1.0",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      store: getStoreStats(),
    };
  });
}
