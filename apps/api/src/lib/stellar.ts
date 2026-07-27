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
    signerPublicKey?: string; // For non-custodial mode
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

/**
 * Builds an unsigned transaction for the escrow lock operation.
 * Returns the unsigned XDR transaction base64 string for client-side signing.
 */
export async function buildLockEscrowTransaction(params: LockParams): Promise<string> {
    const signerPublicKey = params.signerPublicKey || loadSignerKeypair().publicKey();
    const account = await server.getAccount(signerPublicKey);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: params.contractId,
                function: "lock",
                args: [
                    hexToBytesScVal(params.tradeId),
                    nativeToScVal(params.seller, { type: "address" }),
                    nativeToScVal(params.buyer, { type: "address" }),
                    nativeToScVal(params.amountStroops, { type: "i128" }),
                    hexToBytesScVal(params.secretHashHex),
                    nativeToScVal(params.timeoutLedgers, { type: "u32" }),
                ],
            })
        )
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
        throw new Error(`simulation failed: ${sim.error}`);
    }

    const prepared = assembleTransaction(tx, sim).build();
    return prepared.toXDR();
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

/**
 * Builds an unsigned transaction for the escrow release operation.
 * Returns the unsigned XDR transaction base64 string for client-side signing.
 */
export async function buildReleaseEscrowTransaction(params: ReleaseParams & { signerPublicKey?: string }): Promise<string> {
    const signerPublicKey = params.signerPublicKey || loadSignerKeypair().publicKey();
    const account = await server.getAccount(signerPublicKey);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: params.contractId,
                function: "release",
                args: [hexToBytesScVal(params.tradeId), hexToBytesScVal(params.secretHex)],
            })
        )
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
        throw new Error(`simulation failed: ${sim.error}`);
    }

    const prepared = assembleTransaction(tx, sim).build();
    return prepared.toXDR();
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

/**
 * Builds an unsigned transaction for the escrow refund operation.
 * Returns the unsigned XDR transaction base64 string for client-side signing.
 */
export async function buildRefundEscrowTransaction(params: RefundParams & { signerPublicKey?: string }): Promise<string> {
    const signerPublicKey = params.signerPublicKey || loadSignerKeypair().publicKey();
    const account = await server.getAccount(signerPublicKey);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: params.contractId,
                function: "refund",
                args: [hexToBytesScVal(params.tradeId)],
            })
        )
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
        throw new Error(`simulation failed: ${sim.error}`);
    }

    const prepared = assembleTransaction(tx, sim).build();
    return prepared.toXDR();
}

/**
 * Submits a signed transaction XDR to the Stellar network.
 * Waits for transaction confirmation and returns the result.
 */
export async function submitSignedTransaction(signedXdr: string): Promise<{ hash: string; status: string }> {
    const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    const sendResult = await server.sendTransaction(tx);
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

    return { hash: sendResult.hash, status: getResult.status };
}

// ---------------------------------------------------------------------------
// Session Account Contract Functions
// ---------------------------------------------------------------------------

export interface SessionAccountParams {
    contractId: string;
    mainAccount: string;
}

export interface CreateSessionKeyParams {
    contractId: string;
    sessionKey: string;
    spendingCap: bigint;
    durationDays: number;
    startDelayDays: number;
}

export interface RevokeSessionKeyParams {
    contractId: string;
    sessionKey: string;
}

export interface UpdateSpendingCapParams {
    contractId: string;
    sessionKey: string;
    newSpendingCap: bigint;
}

/** Initialize the session account contract with the main account. */
export async function initializeSessionAccount(params: SessionAccountParams): Promise<{ hash: string }> {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "initialize",
        [nativeToScVal(params.mainAccount, { type: "address" })],
        signer,
    ) as Promise<{ hash: string }>;
}

/** Build an unsigned transaction to initialize the session account. */
export async function buildInitializeSessionAccountTx(params: SessionAccountParams & { signerPublicKey: string }): Promise<string> {
    const account = await server.getAccount(params.signerPublicKey);
    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: params.contractId,
                function: "initialize",
                args: [nativeToScVal(params.mainAccount, { type: "address" })],
            })
        )
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
        throw new Error(`simulation failed: ${sim.error}`);
    }

    const prepared = assembleTransaction(tx, sim).build();
    return prepared.toXDR();
}

/** Create a new session key with spending cap and time window. */
export async function createSessionKey(params: CreateSessionKeyParams): Promise<{ hash: string }> {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "create_session_key",
        [
            nativeToScVal(params.sessionKey, { type: "address" }),
            nativeToScVal(params.spendingCap, { type: "i128" }),
            nativeToScVal(params.durationDays, { type: "u32" }),
            nativeToScVal(params.startDelayDays, { type: "u32" }),
        ],
        signer,
    ) as Promise<{ hash: string }>;
}

/** Build an unsigned transaction to create a session key. */
export async function buildCreateSessionKeyTx(params: CreateSessionKeyParams & { signerPublicKey: string }): Promise<string> {
    const account = await server.getAccount(params.signerPublicKey);
    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: params.contractId,
                function: "create_session_key",
                args: [
                    nativeToScVal(params.sessionKey, { type: "address" }),
                    nativeToScVal(params.spendingCap, { type: "i128" }),
                    nativeToScVal(params.durationDays, { type: "u32" }),
                    nativeToScVal(params.startDelayDays, { type: "u32" }),
                ],
            })
        )
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
        throw new Error(`simulation failed: ${sim.error}`);
    }

    const prepared = assembleTransaction(tx, sim).build();
    return prepared.toXDR();
}

/** Revoke a session key immediately. */
export async function revokeSessionKey(params: RevokeSessionKeyParams): Promise<{ hash: string }> {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "revoke_session_key",
        [nativeToScVal(params.sessionKey, { type: "address" })],
        signer,
    ) as Promise<{ hash: string }>;
}

/** Build an unsigned transaction to revoke a session key. */
export async function buildRevokeSessionKeyTx(params: RevokeSessionKeyParams & { signerPublicKey: string }): Promise<string> {
    const account = await server.getAccount(params.signerPublicKey);
    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: params.contractId,
                function: "revoke_session_key",
                args: [nativeToScVal(params.sessionKey, { type: "address" })],
            })
        )
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
        throw new Error(`simulation failed: ${sim.error}`);
    }

    const prepared = assembleTransaction(tx, sim).build();
    return prepared.toXDR();
}

/** Update the spending cap of an existing session key. */
export async function updateSpendingCap(params: UpdateSpendingCapParams): Promise<{ hash: string }> {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "update_spending_cap",
        [
            nativeToScVal(params.sessionKey, { type: "address" }),
            nativeToScVal(params.newSpendingCap, { type: "i128" }),
        ],
        signer,
    ) as Promise<{ hash: string }>;
}

/** Build an unsigned transaction to update a session key's spending cap. */
export async function buildUpdateSpendingCapTx(params: UpdateSpendingCapParams & { signerPublicKey: string }): Promise<string> {
    const account = await server.getAccount(params.signerPublicKey);
    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: params.contractId,
                function: "update_spending_cap",
                args: [
                    nativeToScVal(params.sessionKey, { type: "address" }),
                    nativeToScVal(params.newSpendingCap, { type: "i128" }),
                ],
            })
        )
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
        throw new Error(`simulation failed: ${sim.error}`);
    }

    const prepared = assembleTransaction(tx, sim).build();
    return prepared.toXDR();
}

/** Get information about a session key. */
export async function getSessionKeyInfo(contractId: string, sessionKey: string): Promise<any> {
    const result = await invokeContract(
        contractId,
        "get_session_key",
        [nativeToScVal(sessionKey, { type: "address" })],
        loadSignerKeypair(),
    );
    return result;
}

/** Get the total amount spent by a session key. */
export async function getSessionKeySpent(contractId: string, sessionKey: string): Promise<bigint> {
    const result = await invokeContract(
        contractId,
        "get_spent",
        [nativeToScVal(sessionKey, { type: "address" })],
        loadSignerKeypair(),
    );
    return result as bigint;
}