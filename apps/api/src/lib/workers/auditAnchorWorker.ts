import { Pool } from "pg";
import { anchorAuditRoot } from "../stellar.js";
import { computeMerkleRoot } from "../audit/merkle-aggregator.js";
import { CONTRACTS } from "@velo/shared";

export class AuditAnchorWorker {
    private isRunning = false;
    private timer?: NodeJS.Timeout;

    constructor(
        private pool: Pool,
        private pollIntervalMs = 60000,
        private network: "testnet" | "mainnet" = "testnet"
    ) {}

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.tick();
    }

    stop() {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
        }
    }

    private async tick() {
        if (!this.isRunning) return;

        try {
            await this.processPendingBlocks();
        } catch (e) {
            console.error("AuditAnchorWorker error:", e);
        }

        if (this.isRunning) {
            this.timer = setTimeout(() => this.tick(), this.pollIntervalMs);
        }
    }

    private async processPendingBlocks() {
        const client = await this.pool.connect();
        try {
            const rootRes = await client.query("SELECT COALESCE(MAX(block_index), -1) as max_block FROM audit_roots");
            const maxBlock = BigInt(rootRes.rows[0].max_block);
            
            const maxSeqRes = await client.query("SELECT COALESCE(MAX(sequence_id), 0) as max_seq FROM audit_hash_chain");
            const maxSeq = BigInt(maxSeqRes.rows[0].max_seq);

            const fullyFormedBlocks = maxSeq / 1000n;

            for (let blockIndex = maxBlock + 1n; blockIndex < fullyFormedBlocks; blockIndex++) {
                const startSequence = blockIndex * 1000n + 1n;
                const endSequence = startSequence + 999n;

                await client.query("BEGIN");
                
                const blockRes = await client.query(
                    "SELECT curr_hash FROM audit_hash_chain WHERE sequence_id >= $1 AND sequence_id <= $2 ORDER BY sequence_id ASC",
                    [startSequence.toString(), endSequence.toString()]
                );

                if (blockRes.rows.length === 1000) {
                    const hashes = blockRes.rows.map(r => r.curr_hash);
                    const root = computeMerkleRoot(hashes);

                    const contractId = CONTRACTS[this.network].zkVerifierRegistry;
                    if (contractId === "SET_ME_AFTER_FIRST_DEPLOY" || contractId === "") {
                        throw new Error("zkVerifierRegistry contract not configured");
                    }
                    
                    const txHash = await anchorAuditRoot(contractId, Number(endSequence), root);

                    await client.query(
                        `INSERT INTO audit_roots (block_index, start_sequence, end_sequence, merkle_root, tx_hash)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [blockIndex.toString(), startSequence.toString(), endSequence.toString(), root, txHash]
                    );

                    await client.query("COMMIT");
                    console.log(`Anchored audit block ${blockIndex} with root ${root}`);
                } else {
                    await client.query("ROLLBACK");
                }
            }
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }
    }
}
