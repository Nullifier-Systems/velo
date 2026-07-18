import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { refundEscrow } from "../lib/stellar.js"; // Assuming stellar.ts exports refundEscrow
import { getCashRequest, updateStatus } from "../lib/store.js";

// Basic schema for body validation
interface FlagRequestBody {
  suspicious: boolean;
  notes?: string;
}

interface OverrideHeader {
  'x-admin-api-key': string;
}

export async function adminRoutes(app: FastifyInstance) {
  
  // --- AUTHENTICATION PRE-HANDLER ---
  // Secures all routes registered under this plugin
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
   * GET /admin/trades
   * Acceptance Criteria: Authenticated listing of all trades with status, amounts, and timestamps
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
        
        // --- ADAPT TO YOUR DB CLIENT ---
        const { rows: trades } = await (app as any).pg.query(query);
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
      } catch (error) {
        req.log.error(error, `Failed to flag trade ${id}`);
        return reply.status(500).send({ error: "Could not update trade flag status." });
      }
    }
  );

  /**
   * POST /admin/trades/:id/refund
   * Acceptance Criteria: Manually trigger a refund call for a stuck trade past its timeout
   */
  app.post<{ Params: { id: string } }>(
    "/admin/trades/:id/refund",
    async (req, reply) => {
      const { id } = req.params;
      const operatorName = req.headers["x-admin-operator-name"] || "System Admin";

      // 1. Check local state store for validity
      const record = getCashRequest(id);
      if (!record) {
        return reply.status(404).send({ error: "Trade request not found." });
      }

      if (record.status !== "locked") {
        return reply.status(400).send({ 
          error: `Cannot refund. Only locked trades can be refunded. Current status is '${record.status}'.` 
        });
      }

      // 2. Perform the on-chain manual refund override using Stellar SDK
      try {
        req.log.warn(`Manual refund initiated on-chain for trade ID ${id} by ${operatorName}`);
        
        await refundEscrow({
          contractId: record.contractId,
          tradeId: record.id,
          // Stellar contract will internally enforce the timeline check (stuck trade past timeout ledgers)
        });

      } catch (err) {
        req.log.error(err, "refundEscrow on-chain call failed during admin override");
        return reply.status(502).send({ 
          error: "On-chain refund execution failed", 
          detail: String(err) 
        });
      }

      // 3. Keep DB audit trail clean & up-to-date
      try {
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
        
        // Keep memory/store helper synced 
        updateStatus(id, "refunded");

        return reply.status(200).send({
          status: "success",
          message: "Manual refund processed successfully.",
          trade_id: id,
          new_status: "refunded"
        });

      } catch (dbErr) {
        req.log.error(dbErr, "On-chain transaction succeeded, but internal database sync failed");
        return reply.status(500).send({ 
          error: "Refund successful on-chain, but local database status sync failed. Manual sync needed.",
          trade_id: id
        });
      }
    }
  );
}
