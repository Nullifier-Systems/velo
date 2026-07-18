import {
    BASE_FEE,
    Keypair,
    Networks,
    Operation,
    TransactionBuilder,
    nativeToScVal,
    scValToNative,
    xdr,
} from "@stellar/stellar-sdk";
import { Server, Api, assembleTransaction } from "@stellar/stellar-sdk/rpc";

const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const IS_PUBLIC = process.env.STELLAR_NETWORK === "PUBLIC";
const RPC_ALLOW_HTTP = RPC_URL.startsWith("http://");

export const NETWORK_PASSPHRASE = IS_PUBLIC ? Networks.PUBLIC : Networks.TESTNET;
export const server = new Server(RPC_URL, { allowHttp: RPC_ALLOW_HTTP });

/**
 * Loads the deployer/buyer keypair — testnet-only.
 *
 * On mainnet the API NEVER holds a signing key. Instead:
 *   - `POST /cash/request/prepare` returns an unsigned XDR
 *   - The client signs and submits it
 *   - `POST /cash/request` accepts the signed envelope / tx hash to confirm
 */
function loadSignerKeypair(): Keypair {
    if (IS_PUBLIC) {
        throw new Error(
            "Custodial signing is disabled on PUBLIC network. " +
            "Use the /prepare endpoint to get an unsigned XDR, " +
            "sign it client-side, then call /request with the signed envelope."
        );
    }
    const secret = process.env.BUYER_SECRET_KEY;
    if (!secret) {
        throw new Error(
            "BUYER_SECRET_KEY not set — see apps/api/.env.example. " +
            "This is a testnet-only signer."
        );
    }
    return Keypair.fromSecret(secret);
}

/** Converts a 64-char hex string into the BytesN<32> scval Soroban expects. */
function hexToBytesScVal(hex: string) {
    if (hex.length !== 64) {
        throw new Error(`expected 32-byte hex string (64 chars), got ${hex.length} chars`);
    }
    return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
}

// ---------------------------------------------------------------------------
// Build helpers — return unsigned, simulated XDR (non-custodial flow)
// ---------------------------------------------------------------------------

interface BuildTxResult {
    /** Unsigned transaction XDR (base64) ready for client-side signing. */
    unsignedXdr: string;
    /** Simulated footprint / fee etc. already baked in. */
}

async function buildUnsignedTx(
    contractId: string,
    functionName: string,
    args: xdr.ScVal[],
    source: string,
): Promise<BuildTxResult> {
    const sourceAccount = await server.getAccount(source);
    const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: contractId,
                function: functionName,
                args,
            })
        )
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
        throw new Error(`simulation failed: ${sim.error}`);
    }

    const prepared = assembleTransaction(tx, sim).build();
    return { unsignedXdr: prepared.toXDR() };
}

/**
 * Submits a pre-signed envelope (returned by the client after signing
 * the unsigned XDR from buildUnsignedTx) and polls for confirmation.
 */
async function submitSignedEnvelope(signedXdr: string): Promise<{ hash: string }> {
    const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    const hash = (await server.sendTransaction(tx)).hash;

    const start = Date.now();
    for (;;) {
        if (Date.now() - start > 30_000) {
            throw new Error(`timed out waiting for tx ${hash} to confirm`);
        }
        const result = await server.getTransaction(hash);
        if (result.status === Api.GetTransactionStatus.NOT_FOUND) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
        }
        if (result.status !== Api.GetTransactionStatus.SUCCESS) {
            throw new Error(`tx ${hash} failed with status ${result.status}`);
        }
        return { hash };
    }
}

// ---------------------------------------------------------------------------
// Custodial invoke — testnet only (signs with backend-held key)
// ---------------------------------------------------------------------------

async function invokeContract(
    contractId: string,
    functionName: string,
    args: xdr.ScVal[],
    signer: Keypair,
): Promise<unknown> {
    const account = await server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: contractId,
                function: functionName,
                args,
            })
        )
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
        throw new Error(`simulation failed: ${sim.error}`);
    }

    const prepared = assembleTransaction(tx, sim).build();
    prepared.sign(signer);

    const sendResult = await server.sendTransaction(prepared);
    if (sendResult.status === "ERROR") {
        throw new Error(`submission failed: ${JSON.stringify(sendResult.errorResult)}`);
    }

    let getResult = await server.getTransaction(sendResult.hash);
    const start = Date.now();
    while (getResult.status === Api.GetTransactionStatus.NOT_FOUND) {
        if (Date.now() - start > 30_000) {
            throw new Error(`timed out waiting for tx ${sendResult.hash} to confirm`);
        }
        await new Promise((r) => setTimeout(r, 1500));
        getResult = await server.getTransaction(sendResult.hash);
    }

    if (getResult.status !== Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`tx ${sendResult.hash} failed with status ${getResult.status}`);
    }

    return getResult.returnValue ? scValToNative(getResult.returnValue) : undefined;
}

// ---------------------------------------------------------------------------
// Public API — trade lifecycle
// ---------------------------------------------------------------------------

export interface LockParams {
    contractId: string;
    tradeId: string;
    seller: string;
    buyer: string;
    amountStroops: bigint;
    secretHashHex: string;
    timeoutLedgers: number;
}

/** Build and simulate a lock() transaction, returning unsigned XDR. */
export async function buildLockTx(params: LockParams): Promise<BuildTxResult> {
    return buildUnsignedTx(
        params.contractId,
        "lock",
        [
            hexToBytesScVal(params.tradeId),
            nativeToScVal(params.seller, { type: "address" }),
            nativeToScVal(params.buyer, { type: "address" }),
            nativeToScVal(params.amountStroops, { type: "i128" }),
            hexToBytesScVal(params.secretHashHex),
            nativeToScVal(params.timeoutLedgers, { type: "u32" }),
        ],
        params.buyer,
    );
}

/** Submit a pre-signed lock transaction and confirm it. */
export async function submitLockTx(signedXdr: string): Promise<{ hash: string }> {
    return submitSignedEnvelope(signedXdr);
}

/** Testnet-only: custodial lock (API signs with BUYER_SECRET_KEY). */
export async function lockEscrow(params: LockParams) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "lock",
        [
            hexToBytesScVal(params.tradeId),
            nativeToScVal(params.seller, { type: "address" }),
            nativeToScVal(params.buyer, { type: "address" }),
            nativeToScVal(params.amountStroops, { type: "i128" }),
            hexToBytesScVal(params.secretHashHex),
            nativeToScVal(params.timeoutLedgers, { type: "u32" }),
        ],
        signer,
    );
}

export interface ReleaseParams {
    contractId: string;
    tradeId: string;
    secretHex: string;
}

/** Build and simulate a release() transaction, returning unsigned XDR. */
export async function buildReleaseTx(params: ReleaseParams): Promise<BuildTxResult> {
    return buildUnsignedTx(
        params.contractId,
        "release",
        [hexToBytesScVal(params.tradeId), hexToBytesScVal(params.secretHex)],
        params.tradeId, // source account — any address that can pay the fee
    );
}

/** Submit a pre-signed release transaction and confirm it. */
export async function submitReleaseTx(signedXdr: string): Promise<{ hash: string }> {
    return submitSignedEnvelope(signedXdr);
}

/** Testnet-only: custodial release (API signs). */
export async function releaseEscrow(params: ReleaseParams) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "release",
        [hexToBytesScVal(params.tradeId), hexToBytesScVal(params.secretHex)],
        signer,
    );
}

export interface RefundParams {
    contractId: string;
    tradeId: string;
}

/** Build and simulate a refund() transaction, returning unsigned XDR. */
export async function buildRefundTx(params: RefundParams): Promise<BuildTxResult> {
    return buildUnsignedTx(
        params.contractId,
        "refund",
        [hexToBytesScVal(params.tradeId)],
        params.tradeId,
    );
}

/** Submit a pre-signed refund transaction and confirm it. */
export async function submitRefundTx(signedXdr: string): Promise<{ hash: string }> {
    return submitSignedEnvelope(signedXdr);
}

/** Testnet-only: custodial refund (API signs). */
export async function refundEscrow(params: RefundParams) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "refund",
        [hexToBytesScVal(params.tradeId)],
        signer,
    );
}
