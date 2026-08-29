import { describe, it, expect, vi } from "vitest";
import fastify from "fastify";
import { auditVaultRoutes } from "../audit-vault.js";
import { ProofGenerator } from "../../lib/audit/proof-generator.js";

vi.mock("../../lib/audit/proof-generator.js");

describe("Audit Vault Routes", () => {
    it("should return 404 if proof is not ready", async () => {
        vi.mocked(ProofGenerator.prototype.generateProof).mockRejectedValueOnce(
            new Error("Audit root not yet anchored for this event")
        );

        const app = fastify();
        app.decorate("pg", {}); // Mock pg pool
        app.register(auditVaultRoutes);

        const response = await app.inject({
            method: "GET",
            url: "/audit/proof/123",
        });

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.payload)).toEqual({
            error: "Audit root not yet anchored for this event"
        });
    });

    it("should return proof successfully", async () => {
        vi.mocked(ProofGenerator.prototype.generateProof).mockResolvedValueOnce({
            eventId: "123",
            merkleRoot: "mockRoot",
            proof: ["hash1", "hash2"],
            leafIndex: 5,
            stellarTxHash: "mockTxHash",
            verified: true,
        });

        const app = fastify();
        app.decorate("pg", {}); // Mock pg pool
        app.register(auditVaultRoutes);

        const response = await app.inject({
            method: "GET",
            url: "/audit/proof/123",
        });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({
            eventId: "123",
            merkleRoot: "mockRoot",
            proof: ["hash1", "hash2"],
            leafIndex: 5,
            stellarTxHash: "mockTxHash",
            verified: true,
        });
    });
});
