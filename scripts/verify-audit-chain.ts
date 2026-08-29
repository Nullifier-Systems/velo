import { Pool } from "pg";
import { createHash } from "node:crypto";
import "dotenv/config";

async function verifyChain() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();

    try {
        const { rows } = await client.query(
            "SELECT sequence_id, payload_hash, prev_hash, curr_hash FROM audit_hash_chain ORDER BY sequence_id ASC"
        );

        if (rows.length === 0) {
            console.log("Audit chain is empty. Nothing to verify.");
            return;
        }

        let expectedPrevHash = "0".repeat(64);
        let errorFound = false;

        for (const row of rows) {
            const { sequence_id, payload_hash, prev_hash, curr_hash } = row;

            if (prev_hash !== expectedPrevHash) {
                console.error(`Tamper detected at sequence_id ${sequence_id}: prev_hash does not match expected.`);
                errorFound = true;
                break;
            }

            const computedHash = createHash("sha256").update(payload_hash + prev_hash).digest("hex");
            if (computedHash !== curr_hash) {
                console.error(`Tamper detected at sequence_id ${sequence_id}: curr_hash does not match computed hash.`);
                errorFound = true;
                break;
            }

            expectedPrevHash = curr_hash;
        }

        if (!errorFound) {
            console.log("Audit chain is intact.");
        } else {
            process.exit(1);
        }
    } finally {
        client.release();
        await pool.end();
    }
}

verifyChain().catch(console.error);
