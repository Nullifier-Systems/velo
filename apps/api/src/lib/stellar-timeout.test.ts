import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist RPC server mocks so they are available before the module import.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const preparedTx = {
    sign: () => {},
    hash: () => Buffer.from("00".repeat(32), "hex"),
    fee: "100",
    innerTransaction: undefined as any,
    feeSource: undefined as any,
  };
  return {
    preparedTx,
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  };
});

vi.mock("@stellar/stellar-sdk/rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk/rpc")>();
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

import { Account, Keypair, StrKey } from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { lockEscrow, releaseEscrow, refundEscrow, rpcTimeout, RPC_TIMEOUTS } from "./stellar.js";
import { RpcTimeoutError } from "./rpc-errors.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));

function lockParams() {
  return {
    contractId: CONTRACT_ID,
    tradeId: "a".repeat(64),
    seller: Keypair.random().publicKey(),
    buyer:  Keypair.random().publicKey(),
    amountStroops: 10_000_000n,
    secretHashHex: "b".repeat(64),
    timeoutLedgers: 100,
  };
}

function releaseParams() {
  return { contractId: CONTRACT_ID, tradeId: "a".repeat(64), secretHex: "c".repeat(64) };
}

function refundParams() {
  return { contractId: CONTRACT_ID, tradeId: "a".repeat(64) };
}

// ---------------------------------------------------------------------------
// RpcTimeoutError unit tests
// ---------------------------------------------------------------------------
describe("RpcTimeoutError", () => {
  it("is an instance of Error", () => {
    const err = new RpcTimeoutError("lock/buildSim", 15_001);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RpcTimeoutError);
  });

  it("exposes operation and elapsedMs properties", () => {
    const err = new RpcTimeoutError("release/poll", 30_500);
    expect(err.operation).toBe("release/poll");
    expect(err.elapsedMs).toBe(30_500);
  });

  it("has a descriptive message", () => {
    const err = new RpcTimeoutError("refund/poll", 10_000);
    expect(err.message).toContain("refund/poll");
    expect(err.message).toContain("10000");
  });

  it("has name RpcTimeoutError", () => {
    expect(new RpcTimeoutError("x", 1).name).toBe("RpcTimeoutError");
  });
});

// ---------------------------------------------------------------------------
// rpcTimeout helper
// ---------------------------------------------------------------------------
describe("rpcTimeout", () => {
  it("resolves with the underlying value when the operation completes in time", async () => {
    const result = await rpcTimeout("test/op", 1_000, () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("rejects with RpcTimeoutError when the deadline fires first", async () => {
    const neverResolves = new Promise<never>(() => {});
    await expect(
      rpcTimeout("test/slow", 10, () => neverResolves),
    ).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("includes the operation name in the timeout error", async () => {
    const neverResolves = new Promise<never>(() => {});
    await expect(
      rpcTimeout("my/operation", 10, () => neverResolves),
    ).rejects.toMatchObject({ operation: "my/operation" });
  });

  it("propagates non-timeout errors from the wrapped function", async () => {
    await expect(
      rpcTimeout("test/throws", 1_000, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
  });

  it("does not reject with RpcTimeoutError when the function rejects before deadline", async () => {
    const err = await rpcTimeout(
      "test/fast-fail",
      1_000,
      () => Promise.reject(new Error("fast fail")),
    ).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RpcTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// Per-operation timeout constants
// ---------------------------------------------------------------------------
describe("RPC_TIMEOUTS values", () => {
  it("lock build+sim budget is larger than release/refund (lock is higher value)", () => {
    expect(RPC_TIMEOUTS.lockBuildSim).toBeGreaterThan(RPC_TIMEOUTS.releaseBuildSim);
    expect(RPC_TIMEOUTS.lockBuildSim).toBeGreaterThan(RPC_TIMEOUTS.refundBuildSim);
  });

  it("lock poll budget is larger than release/refund poll (allow more time for lock)", () => {
    expect(RPC_TIMEOUTS.lockPoll).toBeGreaterThan(RPC_TIMEOUTS.releasePoll);
    expect(RPC_TIMEOUTS.lockPoll).toBeGreaterThan(RPC_TIMEOUTS.refundPoll);
  });

  it("all budgets are positive integers in milliseconds", () => {
    for (const [key, value] of Object.entries(RPC_TIMEOUTS)) {
      expect(value, `RPC_TIMEOUTS.${key}`).toBeGreaterThan(0);
      expect(Number.isInteger(value), `RPC_TIMEOUTS.${key} should be integer`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: lockEscrow / releaseEscrow / refundEscrow throw RpcTimeoutError
// when the RPC call stalls beyond the allotted budget.
//
// We override the per-operation timeout constants to tiny values so the tests
// run fast while still exercising the real timeout path.
// ---------------------------------------------------------------------------
describe("custodial operations respect their timeout budgets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const signer = Keypair.random();
    process.env.BUYER_SECRET_KEY = signer.secret();
    h.getAccount.mockResolvedValue(new Account(signer.publicKey(), "0"));
  });

  it("lockEscrow throws RpcTimeoutError when getAccount hangs", async () => {
    // getAccount never resolves → the buildSim phase should timeout
    h.getAccount.mockReturnValue(new Promise(() => {}));

    await expect(
      lockEscrow({ ...lockParams() }, undefined, 50 /* 50 ms buildSim */, 45_000),
    ).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("lockEscrow throws RpcTimeoutError when the poll loop stalls", async () => {
    h.simulateTransaction.mockResolvedValue({});
    h.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "abc" });
    // getTransaction always returns NOT_FOUND so poll never exits
    h.getTransaction.mockResolvedValue({ status: Api.GetTransactionStatus.NOT_FOUND });

    await expect(
      lockEscrow({ ...lockParams() }, undefined, 15_000, 50 /* 50 ms poll */),
    ).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("releaseEscrow throws RpcTimeoutError when getAccount hangs", async () => {
    h.getAccount.mockReturnValue(new Promise(() => {}));

    await expect(
      releaseEscrow(releaseParams(), undefined, 50, 30_000),
    ).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("refundEscrow throws RpcTimeoutError when the poll loop stalls", async () => {
    h.simulateTransaction.mockResolvedValue({});
    h.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "def" });
    h.getTransaction.mockResolvedValue({ status: Api.GetTransactionStatus.NOT_FOUND });

    await expect(
      refundEscrow(refundParams(), undefined, 10_000, 50),
    ).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("lockEscrow succeeds when the RPC responds within budget", async () => {
    h.simulateTransaction.mockResolvedValue({});
    h.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "ok" });
    h.getTransaction.mockResolvedValue({
      status: Api.GetTransactionStatus.SUCCESS,
      returnValue: undefined,
    });

    await expect(lockEscrow({ ...lockParams() })).resolves.toBeUndefined();
  });
});
