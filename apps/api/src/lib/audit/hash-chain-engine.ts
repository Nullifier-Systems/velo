import { Pool } from "pg";
import { createHash } from "node:crypto";
import { AuditLogEvent } from "@velo/shared";

export class HashChainEngine {
    constructor(private pool: Pool) {}

    async appendEvent(eventType: string, payload: Record<string, any>): Promise<AuditLogEvent> {
        const payloadStr = JSON.stringify(payload);
        const payloadHash = createHash("sha256").update(payloadStr).digest("hex");

        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            
            // Get the previous hash. If table is empty, use 64 zeros.
            // Using FOR UPDATE to serialize inserts and prevent gaps/race conditions.
            const { rows } = await client.query(
                "SELECT curr_hash FROM audit_hash_chain ORDER BY sequence_id DESC LIMIT 1 FOR UPDATE"
            );
            const prevHash = rows.length > 0 ? rows[0].curr_hash : "0".repeat(64);

            const currHash = createHash("sha256")
                .update(payloadHash + prevHash)
                .digest("hex");

            const insertRes = await client.query(
                `INSERT INTO audit_hash_chain (event_type, payload_hash, prev_hash, curr_hash)
                 VALUES ($1, $2, $3, $4)
                 RETURNING sequence_id, created_at`,
                [eventType, payloadHash, prevHash, currHash]
            );

            await client.query("COMMIT");

            return {
                sequenceId: insertRes.rows[0].sequence_id,
                eventType,
                payloadHash,
                prevHash,
                currHash,
                createdAt: insertRes.rows[0].created_at.toISOString()
            };
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }
    }
}
