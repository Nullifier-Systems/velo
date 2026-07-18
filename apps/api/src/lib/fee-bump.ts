import {
    Keypair,
    Transaction,
    TransactionBuilder,
    Networks,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "./stellar.js";

/**
 * Loads the fee-bump sponsor keypair from the environment.
 * The fee account pays network fees for users with zero XLM balance.
 */
function loadFeeSponsorKeypair(): Keypair {
    const secret = process.env.FEE_SPONSOR_SECRET_KEY;
    if (!secret) {
        throw new Error(
            "FEE_SPONSOR_SECRET_KEY not set — fee-bump sponsorship requires a " +
            "platform fee account. See apps/api/.env.example."
        );
    }
    return Keypair.fromSecret(secret);
}

export interface FeeBumpResult {
    /** The fee-bump transaction XDR ready for submission */
    feeBumpXdr: string;
    /** The inner transaction hash for tracking */
    innerTxHash: string;
    /** The fee sponsor account that paid the fee */
    feeSponsorPublicKey: string;
    /** The fee amount in stroops */
    feePaid: string;
}

/**
 * Wraps a transaction in a fee-bump transaction, allowing a user with zero
 * XLM balance to submit transactions by having the platform cover the fee.
 *
 * @param innerTx - The original transaction to wrap
 * @param feeAccount - The fee sponsor's keypair (optional, loads from env if not provided)
 * @returns The fee-bump transaction details
 */
export function wrapWithFeeBump(
    innerTx: Transaction,
    feeAccount?: Keypair
): FeeBumpResult {
    const feeKeypair = feeAccount ?? loadFeeSponsorKeypair();

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
        feeKeypair,
        innerTx,
        NETWORK_PASSPHRASE
    );

    feeBumpTx.sign(feeKeypair);

    const feePaid = feeBumpTx.fee();

    return {
        feeBumpXdr: feeBumpTx.toEnvelope().toXDR("base64"),
        innerTxHash: innerTx.hash().toString("hex"),
        feeSponsorPublicKey: feeKeypair.publicKey(),
        feePaid,
    };
}

export interface FeeSponsorshipLog {
    timestamp: string;
    innerTxHash: string;
    feeSponsorPublicKey: string;
    feePaidStroops: string;
    userAccount: string;
    operationType: string;
}

/**
 * Logs a fee sponsorship event for cost tracking and accounting.
 * In production, this would write to a database or analytics service.
 */
export function logFeeSponsorship(log: FeeSponsorshipLog): void {
    console.log(
        JSON.stringify({
            event: "fee_sponsorship",
            ...log,
        })
    );
}
