import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const preparedTx = {
    sign: () => {},
    hash: () => Buffer.from('00'.repeat(32), 'hex'),
  };
  return {
    preparedTx,
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  };
});

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    TransactionBuilder: class extends actual.TransactionBuilder {
      static buildFeeBumpTransaction = () => h.preparedTx;
    },
  };
});

// Mock only the RPC server + assembleTransaction; everything else
// (TransactionBuilder, ScVal conversion, Api enums) stays real.
vi.mock('@stellar/stellar-sdk/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk/rpc')>();
  return {
    ...actual,
    Server: class {
      getAccount = h.getAccount;
      simulateTransaction = h.simulateTransaction;
      sendTransaction = h.sendTransaction;
      getTransaction = h.getTransaction;
    },
    assembleTransaction: () => ({ build: () => h.preparedTx }),
  };
});

import { Account, Keypair, StrKey } from '@stellar/stellar-sdk';
import { Api } from '@stellar/stellar-sdk/rpc';
import { lockEscrow, type StellarLogger } from './stellar.js';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));

interface CapturedLine {
  level: 'info' | 'error';
  obj: Record<string, unknown>;
  msg?: string;
  bindings: Record<string, unknown>;
}

/** Logger that records every line plus the child bindings it was logged under. */
function makeCapturingLogger() {
  const lines: CapturedLine[] = [];
  const make = (bindings: Record<string, unknown>): StellarLogger => ({
    info: (obj: Record<string, unknown>, msg?: string) =>
      lines.push({ level: 'info', obj, msg, bindings }),
    error: (obj: Record<string, unknown>, msg?: string) =>
      lines.push({ level: 'error', obj, msg, bindings }),
    child: (b: Record<string, unknown>) => make({ ...bindings, ...b }),
  });
  return { lines, log: make({}) };
}

function lockParams() {
  return {
    contractId: CONTRACT_ID,
    tradeId: 'a'.repeat(64),
    seller: Keypair.random().publicKey(),
    buyer: Keypair.random().publicKey(),
    amountStroops: 10_000_000n,
    secretHashHex: 'b'.repeat(64),
    timeoutLedgers: 100,
  };
}

describe('stellar invocation lifecycle logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const signer = Keypair.random();
    process.env.BUYER_SECRET_KEY = signer.secret();
    h.getAccount.mockResolvedValue(new Account(signer.publicKey(), '0'));
  });

  it('logs every stage of a successful invocation under the passed logger', async () => {
    h.simulateTransaction.mockResolvedValue({});
    h.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'abc123' });
    h.getTransaction.mockResolvedValue({
      status: Api.GetTransactionStatus.SUCCESS,
      returnValue: undefined,
    });

    const { lines, log } = makeCapturingLogger();
    await lockEscrow(lockParams(), log);

    const stages = lines.map((l) => l.obj.stage);
    expect(stages).toEqual(['build', 'simulate', 'sign', 'submit', 'submit', 'poll']);
    // Every line carries the contract/function bindings from the child logger,
    // so combined with req.log's reqId binding the whole chain is traceable.
    for (const line of lines) {
      expect(line.bindings).toMatchObject({ contract: CONTRACT_ID, fn: 'lock' });
    }
    expect(lines.at(-1)?.msg).toBe('transaction confirmed');
  });

  it('logs an error line with the failing stage when simulation fails', async () => {
    h.simulateTransaction.mockResolvedValue({ error: 'host function failed' });

    const { lines, log } = makeCapturingLogger();
    await expect(lockEscrow(lockParams(), log)).rejects.toThrow(/simulation failed/);

    const errorLine = lines.find((l) => l.level === 'error');
    expect(errorLine?.obj).toMatchObject({ stage: 'simulate', error: 'host function failed' });
  });

  it('logs an error line with the failing stage when submission fails', async () => {
    h.simulateTransaction.mockResolvedValue({});
    h.sendTransaction.mockResolvedValue({ status: 'ERROR', errorResult: { code: 'txBadSeq' } });

    const { lines, log } = makeCapturingLogger();
    await expect(lockEscrow(lockParams(), log)).rejects.toThrow(/submission failed/);

    const errorLine = lines.find((l) => l.level === 'error');
    expect(errorLine?.obj.stage).toBe('submit');
  });

  it('does not throw when no logger is passed (noop fallback)', async () => {
    h.simulateTransaction.mockResolvedValue({});
    h.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'abc123' });
    h.getTransaction.mockResolvedValue({
      status: Api.GetTransactionStatus.SUCCESS,
      returnValue: undefined,
    });

    await expect(lockEscrow(lockParams())).resolves.toBeUndefined();
  });
});
