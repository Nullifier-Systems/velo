import {
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { Server, Api, assembleTransaction } from '@stellar/stellar-sdk/rpc';

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

const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const IS_PUBLIC = process.env.STELLAR_NETWORK === 'PUBLIC';
const RPC_ALLOW_HTTP = RPC_URL.startsWith('http://');

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
      'Custodial signing is disabled on PUBLIC network. ' +
        'Use the /prepare endpoint to get an unsigned XDR, ' +
        'sign it client-side, then call /request with the signed envelope.',
    );
  }
  const secret = process.env.BUYER_SECRET_KEY;
  if (!secret) {
    throw new Error(
      'BUYER_SECRET_KEY not set — see apps/api/.env.example. ' + 'This is a testnet-only signer.',
    );
  }
  return Keypair.fromSecret(secret);
}

/**
 * Loads the platform treasury keypair used to sponsor user transactions
 * via fee-bumps. Defaults to BUYER_SECRET_KEY if SPONSOR_SECRET_KEY is omitted.
 */
function loadSponsorKeypair(): Keypair {
  if (process.env.STELLAR_NETWORK === 'PUBLIC') {
    throw new Error('Custodial sponsor cannot be used on mainnet.');
  }
  const secret = process.env.SPONSOR_SECRET_KEY || process.env.BUYER_SECRET_KEY;
  if (!secret) {
    throw new Error('SPONSOR_SECRET_KEY or BUYER_SECRET_KEY not set — see apps/api/.env.example.');
  }
  return Keypair.fromSecret(secret);
}

/** Converts a 64-char hex string into the BytesN<32> scval Soroban expects. */
function hexToBytesScVal(hex: string) {
  if (hex.length !== 64) {
    throw new Error(`expected 32-byte hex string (64 chars), got ${hex.length} chars`);
  }
  return nativeToScVal(Buffer.from(hex, 'hex'), { type: 'bytes' });
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
      }),
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
  logger: StellarLogger = noopLogger,
): Promise<unknown> {
  const stageLog = logger.child({ contract: contractId, fn: functionName });

  stageLog.info({ stage: 'build', signer: signer.publicKey() }, 'building contract invocation');
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

  stageLog.info({ stage: 'simulate' }, 'simulating transaction');
  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    stageLog.error({ stage: 'simulate', error: sim.error }, 'simulation failed');
    throw new Error(`simulation failed: ${sim.error}`);
  }

  const prepared = assembleTransaction(tx, sim).build() as Transaction;
  prepared.sign(signer);
  const txHash = prepared.hash().toString('hex');
  stageLog.info({ stage: 'sign', txHash }, 'transaction signed');

  const sponsor = loadSponsorKeypair();
  const innerFee = parseInt(prepared.fee, 10);
  const bumpFee = innerFee + parseInt(BASE_FEE, 10);

  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    bumpFee.toString(),
    prepared,
    NETWORK_PASSPHRASE,
  );
  feeBumpTx.sign(sponsor);

  const sendResult = await server.sendTransaction(feeBumpTx);
  if (sendResult.status === 'ERROR') {
    stageLog.error(
      { stage: 'submit', txHash, errorResult: JSON.stringify(sendResult.errorResult) },
      'submission failed',
    );
    throw new Error(`submission failed: ${JSON.stringify(sendResult.errorResult)}`);
  }
  stageLog.info({ stage: 'submit', txHash, status: sendResult.status }, 'transaction accepted');

  let getResult = await server.getTransaction(sendResult.hash);
  const start = Date.now();
  let attempts = 1;
  while (getResult.status === Api.GetTransactionStatus.NOT_FOUND) {
    if (Date.now() - start > 30_000) {
      stageLog.error(
        { stage: 'poll', txHash, attempts, elapsedMs: Date.now() - start },
        'timed out waiting for confirmation',
      );
      throw new Error(`timed out waiting for tx ${sendResult.hash} to confirm`);
    }
    await new Promise((r) => setTimeout(r, 1500));
    getResult = await server.getTransaction(sendResult.hash);
    attempts += 1;
  }

  if (getResult.status !== Api.GetTransactionStatus.SUCCESS) {
    stageLog.error(
      { stage: 'poll', txHash, attempts, status: getResult.status },
      'transaction failed on-chain',
    );
    throw new Error(`tx ${sendResult.hash} failed with status ${getResult.status}`);
  }

  stageLog.info(
    { stage: 'poll', txHash, attempts, elapsedMs: Date.now() - start },
    'transaction confirmed',
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
    'lock',
    [
      hexToBytesScVal(params.tradeId),
      nativeToScVal(params.seller, { type: 'address' }),
      nativeToScVal(params.buyer, { type: 'address' }),
      nativeToScVal(params.amountStroops, { type: 'i128' }),
      hexToBytesScVal(params.secretHashHex),
      nativeToScVal(params.timeoutLedgers, { type: 'u32' }),
    ],
    params.buyer,
  );
}

/** Submit a pre-signed lock transaction and confirm it. */
export async function submitLockTx(signedXdr: string): Promise<{ hash: string }> {
  return submitSignedEnvelope(signedXdr);
}

/** Testnet-only: custodial lock (API signs with BUYER_SECRET_KEY). */
export async function lockEscrow(params: LockParams, logger: StellarLogger = noopLogger) {
  const signer = loadSignerKeypair();
  return invokeContract(
    params.contractId,
    'lock',
    [
      hexToBytesScVal(params.tradeId),
      nativeToScVal(params.seller, { type: 'address' }),
      nativeToScVal(params.buyer, { type: 'address' }),
      nativeToScVal(params.amountStroops, { type: 'i128' }),
      hexToBytesScVal(params.secretHashHex),
      nativeToScVal(params.timeoutLedgers, { type: 'u32' }),
    ],
    signer,
    logger,
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
        function: 'lock',
        args: [
          hexToBytesScVal(params.tradeId),
          nativeToScVal(params.seller, { type: 'address' }),
          nativeToScVal(params.buyer, { type: 'address' }),
          nativeToScVal(params.amountStroops, { type: 'i128' }),
          hexToBytesScVal(params.secretHashHex),
          nativeToScVal(params.timeoutLedgers, { type: 'u32' }),
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

export interface ReleaseParams {
  contractId: string;
  tradeId: string;
  secretHex: string;
}

/** Build and simulate a release() transaction, returning unsigned XDR. */
export async function buildReleaseTx(params: ReleaseParams): Promise<BuildTxResult> {
  return buildUnsignedTx(
    params.contractId,
    'release',
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
    'release',
    [hexToBytesScVal(params.tradeId), hexToBytesScVal(params.secretHex)],
    signer,
  );
}

/**
 * Builds an unsigned transaction for the escrow release operation.
 * Returns the unsigned XDR transaction base64 string for client-side signing.
 */
export async function buildReleaseEscrowTransaction(
  params: ReleaseParams & { signerPublicKey?: string },
): Promise<string> {
  const signerPublicKey = params.signerPublicKey || loadSignerKeypair().publicKey();
  const account = await server.getAccount(signerPublicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: params.contractId,
        function: 'release',
        args: [hexToBytesScVal(params.tradeId), hexToBytesScVal(params.secretHex)],
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

export interface RefundParams {
  contractId: string;
  tradeId: string;
}

/** Build and simulate a refund() transaction, returning unsigned XDR. */
export async function buildRefundTx(params: RefundParams): Promise<BuildTxResult> {
  return buildUnsignedTx(
    params.contractId,
    'refund',
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
  return invokeContract(params.contractId, 'refund', [hexToBytesScVal(params.tradeId)], signer);
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
/**
 * Builds an unsigned transaction for the escrow refund operation.
 * Returns the unsigned XDR transaction base64 string for client-side signing.
 */
export async function buildRefundEscrowTransaction(
  params: RefundParams & { signerPublicKey?: string },
): Promise<string> {
  const signerPublicKey = params.signerPublicKey || loadSignerKeypair().publicKey();
  const account = await server.getAccount(signerPublicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: params.contractId,
        function: 'refund',
        args: [hexToBytesScVal(params.tradeId)],
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

/**
 * Submits a signed transaction XDR to the Stellar network.
 * Waits for transaction confirmation and returns the result.
 */
export async function submitSignedTransaction(
  signedXdr: string,
): Promise<{ hash: string; status: string }> {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sendResult = await server.sendTransaction(tx);
  if (sendResult.status === 'ERROR') {
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
