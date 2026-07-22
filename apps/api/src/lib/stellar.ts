import {
    BASE_FEE,
    FeeBumpTransaction,
    Keypair,
    Networks,
    Operation,
    Transaction,
    TransactionBuilder,
    nativeToScVal,
    scValToNative,
    xdr,
} from "@stellar/stellar-sdk";
import { Server, Api, assembleTransaction } from "@stellar/stellar-sdk/rpc";
export { RpcTimeoutError } from "./rpc-errors.js";
import { RpcTimeoutError } from "./rpc-errors.js";

export interface StellarLogger {
    info: (obj: Record<string, unknown>, msg?: string) => void;
    error: (obj: Record<string, unknown>, msg?: string) => void;
    child: (bindings: Record<string, unknown>) => StellarLogger;
}

const noopLogger: StellarLogger = {
    info: () => {},
    error: () => {},
    child: () => noopLogger,
};

const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const IS_PUBLIC = process.env.STELLAR_NETWORK === "PUBLIC";
const RPC_ALLOW_HTTP = RPC_URL.startsWith("http://");

// ---------------------------------------------------------------------------
// Timeout primitives
// ---------------------------------------------------------------------------

/**
 * Races `fn()` against a deadline timer.  If the deadline fires first,
 * the returned promise rejects with an `RpcTimeoutError`; the underlying
 * promise is left to settle on its own (fire-and-forget semantics — we
 * cannot cancel the Stellar SDK's in-flight fetch).
 *
 * @param operation  Label used in the error message / logs.
 * @param timeoutMs  Maximum wait time in milliseconds.
 * @param fn         Async factory; called immediately.
 */
export async function rpcTimeout<T>(
    operation: string,
    timeoutMs: number,
    fn: () => Promise<T>,
): Promise<T> {
    const start = Date.now();
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new RpcTimeoutError(operation, Date.now() - start));
        }, timeoutMs);

        fn().then(
            (value) => { clearTimeout(timer); resolve(value); },
            (err)   => { clearTimeout(timer); reject(err); },
        );
    });
}

// Per-operation timeout budgets (milliseconds).
// These are deliberate policy choices — see docs/rpc-resilience.md.
export const RPC_TIMEOUTS = {
    /** getAccount + simulateTransaction for a lock() call. */
    lockBuildSim:    15_000,
    /** Poll loop waiting for a lock tx to be confirmed on-chain. */
    lockPoll:        45_000,
    /** getAccount + simulateTransaction for a release() or refund() call. */
    releaseBuildSim: 10_000,
    /** Poll loop for release/refund confirmation. */
    releasePoll:     30_000,
    /** getAccount + simulateTransaction for a refund() call. */
    refundBuildSim:  10_000,
    /** Poll loop for refund confirmation. */
    refundPoll:      30_000,
    /** Generic build+simulate budget used by non-custodial helpers. */
    genericBuildSim: 15_000,
    /** Generic poll budget used by submitSignedEnvelope. */
    genericPoll:     30_000,
} as const;

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

/**
 * Loads the platform treasury keypair used to sponsor user transactions
 * via fee-bumps. Defaults to BUYER_SECRET_KEY if SPONSOR_SECRET_KEY is omitted.
 * Works on both testnet and mainnet when SPONSOR_SECRET_KEY is configured.
 */
function loadSponsorKeypair(): Keypair {
    const secret = process.env.SPONSOR_SECRET_KEY || process.env.BUYER_SECRET_KEY;
    if (!secret) {
        throw new Error(
            "SPONSOR_SECRET_KEY or BUYER_SECRET_KEY not set — see apps/api/.env.example."
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

function wrapWithFeeBumpIfPossible(tx: Transaction | FeeBumpTransaction): Transaction | FeeBumpTransaction {
    if (tx instanceof FeeBumpTransaction) {
        return tx;
    }

    try {
        const sponsor = loadSponsorKeypair();
        const innerFee = parseInt(tx.fee, 10);
        const bumpFee = innerFee + parseInt(BASE_FEE, 10);
        const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
            sponsor,
            bumpFee.toString(),
            tx,
            NETWORK_PASSPHRASE
        );
        feeBumpTx.sign(sponsor);
        return feeBumpTx;
    } catch {
        return tx;
    }
}

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
    buildSimTimeoutMs: number = RPC_TIMEOUTS.genericBuildSim,
): Promise<BuildTxResult> {
    return rpcTimeout(`${functionName}/buildUnsignedTx`, buildSimTimeoutMs, async () => {
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
    });
}

/**
 * Submits a pre-signed envelope (returned by the client after signing
 * the unsigned XDR from buildUnsignedTx) and polls for confirmation.
 */
async function submitSignedEnvelope(
    signedXdr: string,
    pollTimeoutMs: number = RPC_TIMEOUTS.genericPoll,
): Promise<{ hash: string }> {
    const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    const txToSubmit = wrapWithFeeBumpIfPossible(tx);
    const hash = (await server.sendTransaction(txToSubmit)).hash;

    const start = Date.now();
    return rpcTimeout(`submitSignedEnvelope/poll`, pollTimeoutMs, async () => {
        for (;;) {
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
    });
}

// ---------------------------------------------------------------------------
// Custodial invoke — testnet only (signs with backend-held key)
// ---------------------------------------------------------------------------

async function invokeContract(
    contractId: string,
    functionName: string,
    args: xdr.ScVal[],
    signer: Keypair,
    logger: StellarLogger = noopLogger,
    buildSimTimeoutMs: number = RPC_TIMEOUTS.genericBuildSim,
    pollTimeoutMs: number = RPC_TIMEOUTS.genericPoll,
): Promise<unknown> {
    const stageLog = logger.child({ contract: contractId, fn: functionName });

    // ---- build + simulate (time-bounded) -----------------------------------
    stageLog.info({ stage: "build", signer: signer.publicKey() }, "building contract invocation");

    const { prepared, txHash } = await rpcTimeout(
        `${functionName}/buildSim`,
        buildSimTimeoutMs,
        async () => {
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

            stageLog.info({ stage: "simulate" }, "simulating transaction");
            const sim = await server.simulateTransaction(tx);
            if (Api.isSimulationError(sim)) {
                stageLog.error({ stage: "simulate", error: sim.error }, "simulation failed");
                throw new Error(`simulation failed: ${sim.error}`);
            }

            const prepared = assembleTransaction(tx, sim).build() as Transaction;
            prepared.sign(signer);
            const txHash = prepared.hash().toString("hex");
            stageLog.info({ stage: "sign", txHash }, "transaction signed");
            return { prepared, txHash };
        },
    );

    // ---- fee-bump (optional) -----------------------------------------------
    let txToSubmit = prepared;
    if (process.env.SPONSOR_SECRET_KEY) {
        const sponsor = loadSponsorKeypair();
        const innerFee = parseInt(prepared.fee, 10);
        const bumpFee = innerFee + parseInt(BASE_FEE, 10);

        const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
            sponsor,
            bumpFee.toString(),
            prepared,
            NETWORK_PASSPHRASE
        );
        feeBumpTx.sign(sponsor);
        txToSubmit = feeBumpTx;
        stageLog.info({ stage: "fee_bump", sponsor: sponsor.publicKey() }, "transaction fee-bumped");
    }

    // ---- submit ------------------------------------------------------------
    const sendResult = await server.sendTransaction(txToSubmit);
    if (sendResult.status === "ERROR") {
        stageLog.error(
            { stage: "submit", txHash, errorResult: JSON.stringify(sendResult.errorResult) },
            "submission failed"
        );
        throw new Error(`submission failed: ${JSON.stringify(sendResult.errorResult)}`);
    }
    stageLog.info({ stage: "submit", txHash, status: sendResult.status }, "transaction accepted");

    // ---- poll for confirmation (time-bounded) -------------------------------
    const start = Date.now();
    let attempts = 1;

    const getResult = await rpcTimeout(
        `${functionName}/poll`,
        pollTimeoutMs,
        async () => {
            let result = await server.getTransaction(sendResult.hash);
            while (result.status === Api.GetTransactionStatus.NOT_FOUND) {
                await new Promise((r) => setTimeout(r, 1500));
                result = await server.getTransaction(sendResult.hash);
                attempts += 1;
            }
            return result;
        },
    ).catch((err) => {
        if (err instanceof RpcTimeoutError) {
            stageLog.error(
                { stage: "poll", txHash, attempts, elapsedMs: err.elapsedMs },
                "timed out waiting for confirmation"
            );
        }
        throw err;
    });

    if (getResult.status !== Api.GetTransactionStatus.SUCCESS) {
        stageLog.error(
            { stage: "poll", txHash, attempts, status: getResult.status },
            "transaction failed on-chain"
        );
        throw new Error(`tx ${sendResult.hash} failed with status ${getResult.status}`);
    }

    stageLog.info(
        { stage: "poll", txHash, attempts, elapsedMs: Date.now() - start },
        "transaction confirmed"
    );
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
export async function lockEscrow(
    params: LockParams,
    logger: StellarLogger = noopLogger,
    buildSimTimeoutMs: number = RPC_TIMEOUTS.lockBuildSim,
    pollTimeoutMs: number = RPC_TIMEOUTS.lockPoll,
) {
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
        logger,
        buildSimTimeoutMs,
        pollTimeoutMs,
    );
}

/**
 * Builds an unsigned transaction for the escrow lock operation.
 * Returns the unsigned XDR transaction base64 string for client-side signing.
 */
export async function buildLockEscrowTransaction(params: LockParams): Promise<string> {
    const signerPublicKey = params.signerPublicKey || loadSignerKeypair().publicKey();
    return rpcTimeout("lock/buildLockEscrowTransaction", RPC_TIMEOUTS.lockBuildSim, async () => {
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
    });
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
export async function releaseEscrow(
    params: ReleaseParams,
    logger: StellarLogger = noopLogger,
    buildSimTimeoutMs: number = RPC_TIMEOUTS.releaseBuildSim,
    pollTimeoutMs: number = RPC_TIMEOUTS.releasePoll,
) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "release",
        [hexToBytesScVal(params.tradeId), hexToBytesScVal(params.secretHex)],
        signer,
        logger,
        buildSimTimeoutMs,
        pollTimeoutMs,
    );
}

/**
 * Builds an unsigned transaction for the escrow release operation.
 * Returns the unsigned XDR transaction base64 string for client-side signing.
 */
export async function buildReleaseEscrowTransaction(params: ReleaseParams & { signerPublicKey?: string }): Promise<string> {
    const signerPublicKey = params.signerPublicKey || loadSignerKeypair().publicKey();
    return rpcTimeout("release/buildReleaseEscrowTransaction", RPC_TIMEOUTS.releaseBuildSim, async () => {
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
    });
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
export async function refundEscrow(
    params: RefundParams,
    logger: StellarLogger = noopLogger,
    buildSimTimeoutMs: number = RPC_TIMEOUTS.refundBuildSim,
    pollTimeoutMs: number = RPC_TIMEOUTS.refundPoll,
) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "refund",
        [hexToBytesScVal(params.tradeId)],
        signer,
        logger,
        buildSimTimeoutMs,
        pollTimeoutMs,
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

export interface BatchReleaseParams {
    contractId: string;
    /** Each entry mirrors ReleaseParams — one trade id and its revealed secret. */
    releases: { tradeId: string; secretHex: string }[];
}

/** Encodes one (id, secret) pair as the BatchReleaseItem struct the escrow
 * contract expects — an ScMap with keys in alphabetical field order. */
function batchReleaseItemScVal(tradeId: string, secretHex: string): xdr.ScVal {
    return xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("id"),
            val: hexToBytesScVal(tradeId),
        }),
        new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("secret"),
            val: hexToBytesScVal(secretHex),
        }),
    ]);
}

/**
 * Testnet-only: custodial batch release (API signs). Settles many trades'
 * payouts in a single Soroban invocation of the escrow contract's
 * `batch_release()` — the on-chain half of provider payout batching. Each
 * item is still verified against its own trade's secret hash on-chain, so
 * this changes nothing about the trust model versus calling `release()`
 * once per trade — it only reduces how many separate transactions get
 * submitted. See docs/provider-payout-batching.md.
 *
 * Returns the hex trade ids that were actually released (a stale or
 * already-settled entry is skipped by the contract, not rejected as a
 * whole batch).
 */
export async function batchReleaseEscrow(params: BatchReleaseParams): Promise<string[]> {
    const signer = loadSignerKeypair();
    const itemsScVal = xdr.ScVal.scvVec(
        params.releases.map((r) => batchReleaseItemScVal(r.tradeId, r.secretHex))
    );
    const result = await invokeContract(params.contractId, "batch_release", [itemsScVal], signer);
    const releasedIds = (result as Buffer[] | undefined) ?? [];
    return releasedIds.map((id) => Buffer.from(id).toString("hex"));
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

/**
 * Submits a signed transaction XDR to the Stellar network.
 * Waits for transaction confirmation and returns the result.
 */
export async function submitSignedTransaction(signedXdr: string): Promise<{ hash: string; status: string }> {
    const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    const txToSubmit = wrapWithFeeBumpIfPossible(tx);
    const sendResult = await server.sendTransaction(txToSubmit);
    if (sendResult.status === "ERROR") {
        throw new Error(`submission failed: ${JSON.stringify(sendResult.errorResult)}`);
    }

    const getResult = await rpcTimeout(
        "submitSignedTransaction/poll",
        RPC_TIMEOUTS.genericPoll,
        async () => {
            let result = await server.getTransaction(sendResult.hash);
            while (result.status === Api.GetTransactionStatus.NOT_FOUND) {
                await new Promise((r) => setTimeout(r, 1500));
                result = await server.getTransaction(sendResult.hash);
            }
            return result;
        },
    );

    if (getResult.status !== Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`tx ${sendResult.hash} failed with status ${getResult.status}`);
    }

    return { hash: sendResult.hash, status: getResult.status };
}