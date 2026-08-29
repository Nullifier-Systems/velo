import { describe, it, expect } from "vitest";
import { computeMerkleRoot, computeMerkleProof, verifyMerkleProof } from "../merkle-aggregator.js";

describe("Merkle Aggregator", () => {
    it("should compute valid root for single hash", () => {
        const hashes = ["a"];
        const root = computeMerkleRoot(hashes);
        expect(root).toBe("a");
    });

    it("should compute consistent root for multiple hashes", () => {
        const hashes = ["a", "b", "c", "d"];
        const root = computeMerkleRoot(hashes);
        expect(root).toBeTruthy();
        expect(typeof root).toBe("string");
    });

    it("should generate and verify merkle proof", () => {
        const hashes = Array.from({ length: 16 }, (_, i) => `hash${i}`);
        const root = computeMerkleRoot(hashes);

        const leafIndex = 5;
        const leafHash = hashes[leafIndex];
        const proof = computeMerkleProof(hashes, leafIndex);

        expect(proof.length).toBeGreaterThan(0);
        
        const isValid = verifyMerkleProof(leafHash, root, proof, leafIndex);
        expect(isValid).toBe(true);
    });

    it("should fail verification with wrong leaf", () => {
        const hashes = Array.from({ length: 8 }, (_, i) => `hash${i}`);
        const root = computeMerkleRoot(hashes);

        const leafIndex = 3;
        const proof = computeMerkleProof(hashes, leafIndex);

        const isValid = verifyMerkleProof("wrongHash", root, proof, leafIndex);
        expect(isValid).toBe(false);
    });
});
