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
  Account,
} from "@stellar/stellar-sdk";
import { Server, Api, assembleTransaction } from "@stellar/stellar-sdk/rpc";
export { RpcTimeoutError } from "./rpc-errors.js";
import { RpcTimeoutError } from "./rpc-errors.js";

// Re-export commonly used SDK types and constants
export { BASE_FEE, Keypair, Operation, TransactionBuilder, xdr, Account, nativeToScVal, scValToNative };
export { Server, Api, assembleTransaction };

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

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
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
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Per-operation timeout budgets (milliseconds).
// These are deliberate policy choices — see docs/rpc-resilience.md.
export const RPC_TIMEOUTS = {
  /** getAccount + simulateTransaction for a lock() call. */
  lockBuildSim: 15_000,
  /** Poll loop waiting for a lock tx to be confirmed on-chain. */
  lockPoll: 45_000,
  /** getAccount + simulateTransaction for a release() or refund() call. */
  releaseBuildSim: 10_000,
  /** Poll loop for release/refund confirmation. */
  releasePoll: 30_000,
  /** getAccount + simulateTransaction for a refund() call. */
  refundBuildSim: 10_000,
  /** Poll loop for refund confirmation. */
  refundPoll: 30_000,
  /** Generic build+simulate budget used by non-custodial helpers. */
  genericBuildSim: 15_000,
  /** Generic poll budget used by submitSignedEnvelope. */
  genericPoll: 30_000,
} as const;

export const NETWORK_PASSPHRASE = IS_PUBLIC
  ? Networks.PUBLIC
  : Networks.TESTNET;
export const server = new Server(RPC_URL, { allowHttp: RPC_ALLOW_HTTP });

/** Return the latest closed ledger sequence for timeout bookkeeping. */
export async function getLatestLedgerSequence(): Promise<number> {
  return (await server.getLatestLedger()).sequence;
}

/**
 * Loads the deployer/buyer keypair — testnet-only.
 *
 * On mainnet the API NEVER holds a signing key. Instead:
 *   - `POST /cash/request/prepare` returns an unsigned XDR
 *   - The client signs and submits it
 *   - `POST /cash/request` accepts the signed envelope / tx hash to confirm
 */
export function loadSignerKeypair(): Keypair {
  if (IS_PUBLIC) {
    throw new Error(
      "Custodial signing is disabled on PUBLIC network. " +
        "Use the /prepare endpoint to get an unsigned XDR, " +
        "sign it client-side, then call /request with the signed envelope.",
    );
  }
  const secret = process.env.BUYER_SECRET_KEY;
  if (!secret) {
    throw new Error(
      "BUYER_SECRET_KEY not set — see apps/api/.env.example. " +
        "This is a testnet-only signer.",
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
      "SPONSOR_SECRET_KEY or BUYER_SECRET_KEY not set — see apps/api/.env.example.",
    );
  }
  return Keypair.fromSecret(secret);
}

/** Converts a 64-char hex string into the BytesN<32> scval Soroban expects. */
function hexToBytesScVal(hex: string) {
  if (hex.length !== 64) {
    throw new Error(
      `expected 32-byte hex string (64 chars), got ${hex.length} chars`,
    );
  }
  return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
}

/**
 * Invokes a Soroban contract function with custodial signing (testnet-only).
 * Builds, simulates, signs, and submits the transaction.
 */
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
      }),
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
// Read helpers — pause / circuit breaker (issue #266)
// ---------------------------------------------------------------------------

export interface EscrowPauseState {
    /** True only when a pause is armed AND the delay has elapsed. */
    paused: boolean;
    /** Ledger when an armed pause becomes effective; null if not armed. */
    pause_effective_ledger: number | null;
    /** Fixed delay (ledgers) between pause() and effective lock blocking. */
    pause_delay_ledgers: number;
}

/** Source account for read-only simulations (does not need to sign). */
async function simulationAccount(): Promise<Account> {
    const configured =
        process.env.SOROBAN_SIMULATION_SOURCE ||
        process.env.BUYER_PUBLIC_KEY ||
        (process.env.BUYER_SECRET_KEY
            ? Keypair.fromSecret(process.env.BUYER_SECRET_KEY).publicKey()
            : null);

    if (configured) {
        try {
            return await server.getAccount(configured);
        } catch {
            // Fall through to ephemeral account if the key is not funded on this network.
        }
    }

    return new Account(Keypair.random().publicKey(), "0");
}

async function simulateContractRead<T>(
    contractId: string,
    functionName: string,
    args: xdr.ScVal[] = [],
): Promise<T> {
    const account = await simulationAccount();
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
        throw new Error(`simulation failed (${functionName}): ${sim.error}`);
    }
    if (!Api.isSimulationSuccess(sim) || sim.result === undefined) {
        throw new Error(`simulation returned no result for ${functionName}`);
    }

    return scValToNative(sim.result.retval) as T;
}

/**
 * Read the escrow circuit-breaker state from chain (issue #266).
 * Used by the API to refuse new locks and by the frontend to show a clear message.
 */
export async function getEscrowPauseState(contractId: string): Promise<EscrowPauseState> {
    const [paused, effective, delay] = await Promise.all([
        simulateContractRead<boolean>(contractId, "is_paused"),
        simulateContractRead<number | null | undefined>(contractId, "pause_effective_ledger"),
        simulateContractRead<number>(contractId, "pause_delay_ledgers"),
    ]);

    return {
        paused: Boolean(paused),
        pause_effective_ledger:
            effective === null || effective === undefined ? null : Number(effective),
        pause_delay_ledgers: Number(delay),
    };
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

export async function initializeSessionAccount(params: SessionAccountParams): Promise<{ hash: string }> {
  const signer = loadSignerKeypair();
  return invokeContract(
    params.contractId,
    "initialize",
    [nativeToScVal(params.mainAccount, { type: "address" })],
    signer,
  ) as Promise<{ hash: string }>;
}

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

export async function revokeSessionKey(params: RevokeSessionKeyParams): Promise<{ hash: string }> {
  const signer = loadSignerKeypair();
  return invokeContract(
    params.contractId,
    "revoke_session_key",
    [nativeToScVal(params.sessionKey, { type: "address" })],
    signer,
  ) as Promise<{ hash: string }>;
}

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

export async function getSessionKeyInfo(contractId: string, sessionKey: string): Promise<any> {
  const signer = loadSignerKeypair();
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: "get_session_key",
        args: [nativeToScVal(sessionKey, { type: "address" })],
      })
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  if (!sim.result) {
    throw new Error("No result from simulation");
  }

  return scValToNative(sim.result.retval);
}

export async function getSessionKeySpent(contractId: string, sessionKey: string): Promise<bigint> {
  const signer = loadSignerKeypair();
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: "get_spent",
        args: [nativeToScVal(sessionKey, { type: "address" })],
      })
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  if (!sim.result) {
    throw new Error("No result from simulation");
  }

  return scValToNative(sim.result.retval) as bigint;
}

// ---------------------------------------------------------------------------
// Legacy escrow API wrappers (for backward compatibility)
// ---------------------------------------------------------------------------

export interface LockParams {
  contractId: string;
  tradeId: string;
  buyer: string;
  seller: string;
  amountStroops?: bigint;
  amount?: bigint;
  secretHashHex?: string;
  timeoutLedgers: number;
}

export interface TimeoutOptions {
  buildSimTimeout?: number;
  pollTimeout?: number;
}

export interface ReleaseParams {
  contractId: string;
  tradeId: string;
  releaseTo?: string;
  secretHex?: string;
}

export interface RefundParams {
  contractId: string;
  tradeId: string;
}

export interface DisputeParams {
  contractId: string;
  tradeId: string;
  caller: string;
}

export interface ResolveDisputeParams {
  contractId: string;
  tradeId: string;
  buyerShare?: number;
  buyerShareBps?: number;
}

export interface BatchReleaseParams {
  contractId: string;
  trades?: Array<{ tradeId: string; releaseTo: string }>;
  releases?: Array<{ tradeId: string; releaseTo?: string; secretHex?: string }>;
}

/** Testnet-only: custodial lock (API signs with BUYER_SECRET_KEY). */
export async function lockEscrow(
  params: LockParams,
  logger: StellarLogger = noopLogger,
  options?: TimeoutOptions,
): Promise<number> {
  const signer = loadSignerKeypair();
  const amount = params.amountStroops ?? params.amount;
  const result = await invokeContract(
    params.contractId,
    "lock",
    [
      nativeToScVal(params.tradeId, { type: "bytes" }),
      nativeToScVal(params.buyer, { type: "address" }),
      nativeToScVal(params.seller, { type: "address" }),
      nativeToScVal(amount, { type: "u128" }),
      nativeToScVal(params.timeoutLedgers, { type: "u32" }),
    ],
    signer,
  );
  // Return the ledger number from the result
  return (result as { locked_at_ledger: number }).locked_at_ledger;
}

/** Builds an unsigned transaction for the escrow lock operation. */
export async function buildLockEscrowTransaction(
  params: LockParams & { signerPublicKey?: string },
): Promise<string> {
  const signerPublicKey =
    params.signerPublicKey || loadSignerKeypair().publicKey();
  const amount = params.amountStroops ?? params.amount;
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
          nativeToScVal(params.tradeId, { type: "bytes" }),
          nativeToScVal(params.buyer, { type: "address" }),
          nativeToScVal(params.seller, { type: "address" }),
          nativeToScVal(amount, { type: "u128" }),
          nativeToScVal(params.timeoutLedgers, { type: "u32" }),
        ],
      }),
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

/** Testnet-only: custodial release (API signs). */
export async function releaseEscrow(
  params: ReleaseParams,
  logger: StellarLogger = noopLogger,
  options?: TimeoutOptions,
): Promise<{ hash: string }> {
  const signer = loadSignerKeypair();
  return invokeContract(
    params.contractId,
    "release",
    [
      nativeToScVal(params.tradeId, { type: "bytes" }),
      nativeToScVal(params.releaseTo, { type: "address" }),
    ],
    signer,
  ) as Promise<{ hash: string }>;
}

/** Testnet-only: custodial refund (API signs). */
export async function refundEscrow(
  params: RefundParams,
  logger: StellarLogger = noopLogger,
  options?: TimeoutOptions,
): Promise<{ hash: string }> {
  const signer = loadSignerKeypair();
  return invokeContract(
    params.contractId,
    "refund",
    [nativeToScVal(params.tradeId, { type: "bytes" })],
    signer,
  ) as Promise<{ hash: string }>;
}

/** Calls escrow's raise_dispute(caller, id). Flagged by either buyer or seller. */
export async function disputeEscrow(params: DisputeParams) {
  const signer = loadSignerKeypair();
  return invokeContract(
    params.contractId,
    "raise_dispute",
    [
      nativeToScVal(params.caller, { type: "address" }),
      nativeToScVal(params.tradeId, { type: "bytes" }),
    ],
    signer,
  );
}

/** Calls escrow's resolve_dispute(buyer_share). buyer_share is 0-10000 (basis points). */
export async function resolveDisputeEscrow(params: ResolveDisputeParams) {
  const signer = loadSignerKeypair();
  const buyerShare = params.buyerShareBps ?? params.buyerShare;
  return invokeContract(
    params.contractId,
    "resolve_dispute",
    [
      nativeToScVal(params.tradeId, { type: "bytes" }),
      nativeToScVal(buyerShare, { type: "u32" }),
    ],
    signer,
  );
}

/** Submits a signed transaction XDR to the Stellar network. */
export async function submitSignedTransaction(
  signedXdr: string,
): Promise<{ hash: string; status: string; ledger: number }> {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const txToSubmit = wrapWithFeeBumpIfPossible(tx);
  const sendResult = await server.sendTransaction(txToSubmit);

  if (sendResult.status === "ERROR") {
    throw new Error(`submission failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const getResult = await rpcTimeout(
    `submitSignedTransaction/poll`,
    RPC_TIMEOUTS.genericPoll,
    async () => {
      let result = await server.getTransaction(sendResult.hash);
      if (result.status === Api.GetTransactionStatus.NOT_FOUND) {
        await new Promise((r) => setTimeout(r, 1500));
        return null;
      }
      if (result.status !== Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`tx ${sendResult.hash} failed with status ${result.status}`);
      }
      return result;
    },
  );

  if (!getResult) {
    throw new Error(`timed out waiting for tx ${sendResult.hash} to confirm`);
  }

  return {
    hash: sendResult.hash,
    status: getResult.status,
    ledger: getResult.ledger || 0,
  };
}

/** Submit a pre-signed release transaction and confirm it. */
export async function submitReleaseTx(
  signedXdr: string,
): Promise<{ hash: string }> {
  return submitSignedEnvelope(signedXdr);
}

/** Submit a pre-signed refund transaction and confirm it. */
export async function submitRefundTx(
  signedXdr: string,
): Promise<{ hash: string }> {
  return submitSignedEnvelope(signedXdr);
}

/** Submits a pre-signed envelope (returned by the client after signing the unsigned XDR). */
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

/** Wraps a transaction with a fee-bump if a sponsor key is configured. */
function wrapWithFeeBumpIfPossible(
  tx: Transaction | FeeBumpTransaction,
): Transaction | FeeBumpTransaction {
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
      NETWORK_PASSPHRASE,
    );
    feeBumpTx.sign(sponsor);
    return feeBumpTx;
  } catch (err) {
    console.warn("fee-bump wrap skipped:", err);
    return tx;
  }
}

/** Testnet-only: custodial batch release (API signs). */
export async function batchReleaseEscrow(
  params: BatchReleaseParams,
): Promise<string[]> {
  const signer = loadSignerKeypair();
  const hashes: string[] = [];
  const trades = params.trades ?? params.releases ?? [];

  for (const trade of trades) {
    const result = await invokeContract(
      params.contractId,
      "release",
      [
        nativeToScVal(trade.tradeId, { type: "bytes" }),
        nativeToScVal(trade.releaseTo, { type: "address" }),
      ],
      signer,
    );
    hashes.push((result as { hash: string }).hash);
  }

  return hashes;
}

/** Testnet-only: custodial batch release (API signs) - alternative name. */
export async function releaseBatchEscrow(
  params: BatchReleaseParams,
  logger: StellarLogger = noopLogger,
  buildSimTimeoutMs: number = RPC_TIMEOUTS.releaseBuildSim,
): Promise<{ hash: string }[]> {
  const hashes = await batchReleaseEscrow(params);
  return hashes.map((hash) => ({ hash }));
}

/** Returns the on-chain status of a trade. */
export async function getTradeOnChain(
  contractId: string,
  tradeId: string,
): Promise<{ status: string } | null> {
  try {
    const signer = loadSignerKeypair();
    const account = await server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: "get_trade",
          args: [nativeToScVal(tradeId, { type: "bytes" })],
        }),
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
      throw new Error(`simulation failed: ${sim.error}`);
    }

    if (!sim.result) {
      throw new Error("No result from simulation");
    }

    const result = scValToNative(sim.result.retval) as { status: string };
    return result;
  } catch (err) {
    console.error("Failed to get trade on-chain:", err);
    return null;
  }
}