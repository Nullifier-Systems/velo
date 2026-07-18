import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./stellar.js", () => ({
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
}));

describe("fee-bump", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    describe("wrapWithFeeBump", () => {
        it("throws when no fee account is provided and env var is missing", async () => {
            delete process.env.FEE_SPONSOR_SECRET_KEY;

            vi.doMock("./stellar.js", () => ({
                NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
            }));

            const { wrapWithFeeBump } = await import("./fee-bump.js");

            const mockTx = {
                hash: () => Buffer.from("abcdef", "hex"),
            } as any;

            expect(() => wrapWithFeeBump(mockTx)).toThrow(
                "FEE_SPONSOR_SECRET_KEY not set"
            );
        });

        it("wraps a transaction using provided fee account", async () => {
            vi.doMock("./stellar.js", () => ({
                NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
            }));

            const { wrapWithFeeBump } = await import("./fee-bump.js");
            const { Keypair, TransactionBuilder } = await import("@stellar/stellar-sdk");

            const feeKeypair = Keypair.random();
            const mockFeeBumpTx = {
                fee: () => "200",
                sign: vi.fn(),
                toEnvelope: vi.fn().mockReturnValue({
                    toXDR: vi.fn().mockReturnValue("base64-xdr"),
                }),
            };

            vi.spyOn(TransactionBuilder, "buildFeeBumpTransaction").mockReturnValue(mockFeeBumpTx as any);

            const mockTx = {
                hash: () => Buffer.from("abcdef1234567890abcdef1234567890", "hex"),
            } as any;

            const result = wrapWithFeeBump(mockTx, feeKeypair);

            expect(result.feeBumpXdr).toBe("base64-xdr");
            expect(result.feeSponsorPublicKey).toBe(feeKeypair.publicKey());
            expect(result.feePaid).toBe("200");
            expect(mockFeeBumpTx.sign).toHaveBeenCalledWith(feeKeypair);
        });
    });

    describe("logFeeSponsorship", () => {
        it("logs fee sponsorship event to console", async () => {
            const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            vi.doMock("./stellar.js", () => ({
                NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
            }));

            const { logFeeSponsorship } = await import("./fee-bump.js");

            logFeeSponsorship({
                timestamp: "2025-01-15T10:30:00.000Z",
                innerTxHash: "abc123",
                feeSponsorPublicKey: "GTEST123",
                feePaidStroops: "100",
                userAccount: "GUSER456",
                operationType: "lock",
            });

            expect(consoleSpy).toHaveBeenCalledOnce();
            const loggedData = JSON.parse(consoleSpy.mock.calls[0][0]);
            expect(loggedData.event).toBe("fee_sponsorship");
            expect(loggedData.innerTxHash).toBe("abc123");
            expect(loggedData.userAccount).toBe("GUSER456");

            consoleSpy.mockRestore();
        });
    });
});
