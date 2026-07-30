import "dotenv/config";

import {
  Account,
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
import { CONTRACTS } from "../packages/shared/src/index.js";

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const IS_PUBLIC = process.env.STELLAR_NETWORK === "PUBLIC";
const NETWORK_PASSPHRASE = IS_PUBLIC ? Networks.PUBLIC : Networks.TESTNET;
const RPC_ALLOW_HTTP = RPC_URL.startsWith("http://");

const server = new Server(RPC_URL, { allowHttp: RPC_ALLOW_HTTP });

const ESCROW_CONTRACT_ID: string =
  process.env.ESCROW_CONTRACT_ID ||
  CONTRACTS[IS_PUBLIC ? "mainnet" : "testnet"].escrow;

const BOT_SECRET_KEY: string | undefined =
  process.env.REFUND_BOT_SECRET_KEY || process.env.BUYER_SECRET_KEY;

const SPONSOR_SECRET_KEY: string | undefined =
  process.env.SPONSOR_SECRET_KEY;

if (!BOT_SECRET_KEY) {
  console.error(
    "REFUND_BOT_SECRET_KEY (or BUYER_SECRET_KEY) must be set in .env",
  );
  process.exit(1);
}

const botKeypair = Keypair.fromSecret(BOT_SECRET_KEY);

interface OnChainTrade {
  seller: string;
  buyer: string;
  amount: string;
  secretHashHex: string;
  timeoutLedger: number;
  status: string;
}

function hexToBytesScVal(hex: string): xdr.ScVal {
  if (hex.length !== 64) {
    throw new Error(
      `expected 32-byte hex string (64 chars), got ${hex.length} chars`,
    );
  }
  return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function simulateContractRead<T>(
  contractId: string,
  functionName: string,
  args: xdr.ScVal[] = [],
): Promise<T> {
  const source = Keypair.random();
  const account = new Account(source.publicKey(), "0");
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
    throw new Error(`simulation failed (${functionName}): ${sim.error}`);
  }
  if (!Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`simulation returned no result for ${functionName}`);
  }
  return scValToNative(sim.result.retval) as T;
}

async function getTradeState(
  contractId: string,
  tradeId: string,
): Promise<OnChainTrade | null> {
  try {
    const native = await simulateContractRead<Record<string, unknown> | null>(
      contractId,
      "get_trade",
      [hexToBytesScVal(tradeId)],
    );
    if (!native) return null;

    const rawStatus = native.status;
    let status: string;
    if (typeof rawStatus === "string") {
      status = rawStatus.toLowerCase();
    } else if (
      rawStatus &&
      typeof rawStatus === "object" &&
      "name" in rawStatus
    ) {
      status = String((rawStatus as { name: unknown }).name).toLowerCase();
    } else {
      status = String(rawStatus).toLowerCase();
    }

    return {
      seller: String(native.seller),
      buyer: String(native.buyer),
      amount: String(native.amount),
      secretHashHex: Buffer.from(
        native.secret_hash as Buffer,
      ).toString("hex"),
      timeoutLedger: Number(native.timeout_ledger),
      status,
    };
  } catch {
    return null;
  }
}

async function submitRefundTx(tradeId: string): Promise<string> {
  const account = await server.getAccount(botKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: ESCROW_CONTRACT_ID,
        function: "refund",
        args: [hexToBytesScVal(tradeId)],
      }),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  const prepared = assembleTransaction(tx, sim).build() as Transaction;
  prepared.sign(botKeypair);

  let txToSubmit: Transaction | FeeBumpTransaction = prepared;
  if (SPONSOR_SECRET_KEY) {
    const sponsor = Keypair.fromSecret(SPONSOR_SECRET_KEY);
    const innerFee = parseInt(prepared.fee, 10);
    const bumpFee = innerFee + parseInt(BASE_FEE, 10);
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      sponsor,
      bumpFee.toString(),
      prepared,
      NETWORK_PASSPHRASE,
    );
    feeBumpTx.sign(sponsor);
    txToSubmit = feeBumpTx;
  }

  const sendResult = await server.sendTransaction(txToSubmit);
  if (sendResult.status === "ERROR") {
    throw new Error(
      `submission failed: ${JSON.stringify(sendResult.errorResult)}`,
    );
  }

  const hash = sendResult.hash;
  let result = await server.getTransaction(hash);
  while (result.status === Api.GetTransactionStatus.NOT_FOUND) {
    await sleep(1500);
    result = await server.getTransaction(hash);
  }

  if (result.status !== Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`tx ${hash} failed with status ${result.status}`);
  }

  return hash;
}

async function refundWithRetry(tradeId: string): Promise<void> {
  const maxRetries = 5;
  let attempt = 0;
  let delay = 1000;

  while (attempt <= maxRetries) {
    try {
      const hash = await submitRefundTx(tradeId);
      console.log(`Refunded ${tradeId} (tx: ${hash})`);
      return;
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        console.error(
          `Failed to refund ${tradeId} after ${maxRetries} retries:`,
          err,
        );
        return;
      }
      console.warn(
        `Retry ${attempt}/${maxRetries} for ${tradeId} in ${delay}ms...`,
        err instanceof Error ? err.message : err,
      );
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

async function scanExpiredAndRefund(dryRun: boolean): Promise<void> {
  const [latest, tradeCount] = await Promise.all([
    server.getLatestLedger(),
    simulateContractRead<number>(ESCROW_CONTRACT_ID, "get_trade_count"),
  ]);
  const currentLedger = latest.sequence;

  console.log(
    `\n[${new Date().toISOString()}] Ledger ${currentLedger} | Trades: ${tradeCount} | Contract: ${ESCROW_CONTRACT_ID}`,
  );

  const expiredTradeIds: string[] = [];

  for (let i = 1; i <= tradeCount; i++) {
    const tradeIdBuf = await simulateContractRead<Buffer | null>(
      ESCROW_CONTRACT_ID,
      "get_trade_by_index",
      [nativeToScVal(i, { type: "u32" })],
    );
    if (!tradeIdBuf) continue;

    const tradeId = Buffer.from(tradeIdBuf).toString("hex");
    const state = await getTradeState(ESCROW_CONTRACT_ID, tradeId);
    if (!state) continue;

    if (state.status !== "locked") continue;
    if (currentLedger < state.timeoutLedger) continue;

    expiredTradeIds.push(tradeId);
  }

  if (expiredTradeIds.length === 0) {
    console.log("No expired escrows found.");
    return;
  }

  console.log(
    `Found ${expiredTradeIds.length} expired escrow(s): ${expiredTradeIds.join(", ")}`,
  );

  for (const tradeId of expiredTradeIds) {
    if (dryRun) {
      console.log(`DRY RUN: would refund trade ${tradeId}`);
      continue;
    }

    try {
      await refundWithRetry(tradeId);
    } catch {
      console.error(`Skipping trade ${tradeId} after failures`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const intervalIdx = args.indexOf("--interval");
  const intervalMs =
    intervalIdx !== -1
      ? parseInt(args[intervalIdx + 1], 10) * 1000
      : 0;

  console.log(
    `Refund Bot started (dry-run: ${dryRun}, interval: ${intervalMs > 0 ? intervalMs / 1000 + "s" : "once"})`,
  );
  console.log(`Escrow contract: ${ESCROW_CONTRACT_ID}`);
  console.log(`Signer: ${botKeypair.publicKey()}`);

  do {
    await scanExpiredAndRefund(dryRun);
    if (intervalMs > 0) {
      await sleep(intervalMs);
    }
  } while (intervalMs > 0);
}

main().catch((err) => {
  console.error("Bot crashed:", err);
  process.exit(1);
});
