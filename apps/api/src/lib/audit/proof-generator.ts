import { Pool } from "pg";
import { AuditInclusionProof } from "@velo/shared";
import { computeMerkleRoot, computeMerkleProof } from "./merkle-aggregator.js";

export class ProofGenerator {
    constructor(private pool: Pool) {}

    async generateProof(sequenceIdStr: string): Promise<AuditInclusionProof> {
        const sequenceId = BigInt(sequenceIdStr);
        // Each block is 1000 events
        const blockIndex = (sequenceId - 1n) / 1000n;
        const startSequence = blockIndex * 1000n + 1n;
        const endSequence = startSequence + 999n;

        const client = await this.pool.connect();
        try {
            // Check if block is anchored
            const rootRes = await client.query(
                "SELECT merkle_root, tx_hash FROM audit_roots WHERE block_index = $1",
                [blockIndex.toString()]
            );

            if (rootRes.rows.length === 0) {
                throw new Error("Audit root not yet anchored for this event");
            }

            const { merkle_root: root, tx_hash: txHash } = rootRes.rows[0];

            // Fetch the entire block
            const blockRes = await client.query(
                "SELECT sequence_id, curr_hash FROM audit_hash_chain WHERE sequence_id >= $1 AND sequence_id <= $2 ORDER BY sequence_id ASC",
                [startSequence.toString(), endSequence.toString()]
            );

            if (blockRes.rows.length === 0) {
                throw new Error("Events not found in block");
            }

            const hashes = blockRes.rows.map(r => r.curr_hash);
            const computedRoot = computeMerkleRoot(hashes);

            // Find index of requested event
            const leafIndex = blockRes.rows.findIndex(r => r.sequence_id === sequenceIdStr);
            if (leafIndex === -1) {
                throw new Error("Event not found in fetched block");
            }

            const proof = computeMerkleProof(hashes, leafIndex);

            return {
                eventId: sequenceIdStr,
                merkleRoot: root,
                proof,
                leafIndex,
                stellarTxHash: txHash,
                verified: computedRoot === root
            };
        } finally {
            client.release();
        }
    }
}
