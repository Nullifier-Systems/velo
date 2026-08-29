import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { exec } from "child_process";
import { promisify } from "util";
import { Pool } from "pg";
import { HashChainEngine } from "../../apps/api/src/lib/audit/hash-chain-engine.js";

const execAsync = promisify(exec);

describe("Audit Tamper Detection E2E", () => {
    let pool: Pool;
    let engine: HashChainEngine;

    beforeAll(async () => {
        pool = new Pool({ connectionString: process.env.DATABASE_URL });
        engine = new HashChainEngine(pool);

        // Ensure table is clean for test
        await pool.query("TRUNCATE audit_hash_chain RESTART IDENTITY CASCADE");
    });

    afterAll(async () => {
        await pool.query("TRUNCATE audit_hash_chain RESTART IDENTITY CASCADE");
        await pool.end();
    });

    it("should generate sequential hash chains", async () => {
        const ev1 = await engine.appendEvent("TEST_EVENT", { amount: 100 });
        const ev2 = await engine.appendEvent("TEST_EVENT", { amount: 200 });

        expect(ev2.prevHash).toBe(ev1.currHash);
    });

    it("CLI tool should verify intact chain successfully", async () => {
        const { stdout } = await execAsync("npx tsx scripts/verify-audit-chain.ts", {
            env: { ...process.env }
        });
        expect(stdout).toContain("Audit chain is intact.");
    });

    it("CLI tool should detect tampering", async () => {
        // Mutate the payload hash to break the chain
        await pool.query(
            "UPDATE audit_hash_chain SET payload_hash = 'TAMPERED_HASH' WHERE sequence_id = 1"
        );

        let errorFound = false;
        try {
            await execAsync("npx tsx scripts/verify-audit-chain.ts", {
                env: { ...process.env }
            });
        } catch (err: any) {
            errorFound = true;
            expect(err.stderr).toContain("Tamper detected at sequence_id 1");
        }

        expect(errorFound).toBe(true);
    });
});
