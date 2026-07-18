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
export const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;

export const server = new Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });

/**
 * Loads the deployer/buyer keypair used to sign escrow calls.
 *
 * TODO (production): this is a custodial shortcut for testnet — the API
 * signs on the user's behalf using a backend-held key. Before mainnet,
 * replace this with non-custodial flow: the API returns an unsigned XDR
 * transaction, the user's wallet (or an agent's signer) signs it
 * client-side, and only the signed envelope comes back to be submitted.
 */
function loadSignerKeypair(): Keypair {
    if (process.env.STELLAR_NETWORK === "PUBLIC") {
        throw new Error("Custodial signer cannot be used on mainnet.");
    }
    const secret = process.env.BUYER_SECRET_KEY;
    if (!secret) {
        throw new Error(
            "BUYER_SECRET_KEY not set — see apps/api/.env.example. This is a " +
            "testnet-only signer used until non-custodial signing is wired up."
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

/**
 * Builds, simulates, signs, submits, and polls a Soroban contract
 * invocation to completion. Throws if the transaction fails at any
 * stage. Returns the decoded native return value on success.
 */
async function invokeContract(
    contractId: string,
    functionName: string,
    args: xdr.ScVal[],
    signer: Keypair
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

export interface LockParams {
    contractId: string;
    tradeId: string;
    seller: string;
    buyer: string;
    amountStroops: bigint;
    secretHashHex: string;
    timeoutLedgers: number;
}

/** Calls escrow's lock(id, seller, buyer, amount, secret_hash, timeout_ledgers). */
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
        signer
    );
}

export interface ReleaseParams {
    contractId: string;
    tradeId: string;
    secretHex: string;
}

/** Calls escrow's release(id, secret). Pays the seller, reveals the secret on-chain. */
export async function releaseEscrow(params: ReleaseParams) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "release",
        [hexToBytesScVal(params.tradeId), hexToBytesScVal(params.secretHex)],
        signer
    );
}

export interface RefundParams {
    contractId: string;
    tradeId: string;
}

/** Calls escrow's refund(id). Permissionless once the timeout has passed. */
export async function refundEscrow(params: RefundParams) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "refund",
        [hexToBytesScVal(params.tradeId)],
        signer
    );
}

export interface DisputeParams {
    contractId: string;
    tradeId: string;
    caller: string;
}

/** Calls escrow's dispute(caller, id). Flagged by either buyer or seller. */
export async function disputeEscrow(params: DisputeParams) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "dispute",
        [
            nativeToScVal(params.caller, { type: "address" }),
            hexToBytesScVal(params.tradeId),
        ],
        signer
    );
}

export interface ResolveParams {
    contractId: string;
    tradeId: string;
    resolveToBuyer: boolean;
}

/** Calls escrow's resolve(id, resolve_to_buyer). Admin-only. */
export async function resolveEscrow(params: ResolveParams) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "resolve",
        [
            hexToBytesScVal(params.tradeId),
            nativeToScVal(params.resolveToBuyer),
        ],
        signer
    );
}