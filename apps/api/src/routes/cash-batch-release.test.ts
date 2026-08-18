import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { cashRoutes } from "./cash.js";
import { releaseBatchAtomic } from "../lib/stellar.js";
import { ApiError } from "../lib/errors.js";
import { RpcTimeoutError } from "../lib/rpc-errors.js";
import {
  saveCashRequest,
  getCashRequest,
  clearStore,
  CashRequestRecord,
} from "../lib/store.js";
import { clearNotificationQueue } from "../lib/notification.js";

// The route settles the batch through the escrow contract's atomic
// release_batch() entrypoint (exposed as releaseBatchAtomic). Mock the whole
// stellar module so no real ledger call happens; only releaseBatchAtomic is
// exercised by this route.
vi.mock("../lib/stellar.js", () => ({
  lockEscrow: vi.fn(),
  lockEscrowWithTranches: vi.fn(),
  releaseEscrow: vi.fn(),
  releaseTrancheEscrow: vi.fn(),
  refundEscrow: vi.fn(),
  disputeEscrow: vi.fn(),
  buildLockEscrowTransaction: vi.fn(),
  submitSignedTransaction: vi.fn(),
  submitReleaseTx: vi.fn(),
  submitRefundTx: vi.fn(),
  buildChainReleaseToLockTransaction: vi.fn(),
  submitChainReleaseToLockTx: vi.fn(),
  getTradeState: vi.fn(),
  getEscrowPauseState: vi.fn(),
  releaseBatchAtomic: vi.fn().mockResolvedValue(undefined),
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  getLatestLedgerSequence: vi.fn().mockResolvedValue(1_000),
  getTradeOnChain: vi.fn().mockResolvedValue(null),
}));

const SELLER = "GBUQWP3BOUZX34ULNQG23RQ6F4BQXQMJG7YTJWD3JSDT7Z7M2MKAQQ3Q";
const SELLER_2 = "GDUTHCF37UX32EMANXIL2WOOVEDP47GHBOENQWP7CJX3ULSQ5DVEHVXY";
const BUYER = "GBZZPNNDSWBMVRZRJ3F3LCHQB3MNLTMHP4J2JGVG3CKCQJX2NXVM3IGXY";
const CONTRACT = "CBQHTOHBCD4V6O5BSTL3EJOXQX5EV7VBZTSWZVXZG2JNYGVG5ZX7ZX7E";
const CONTRACT_2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const URL = "/api/v1/cash/batch-release";

/** 64-hex trade id, matching the route's `^[0-9a-f]{64}$` schema. */
function tradeId(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function makeTrade(
  n: number,
  overrides: Partial<CashRequestRecord> = {},
): CashRequestRecord {
  const record: CashRequestRecord = {
    id: tradeId(n),
    contractId: CONTRACT,
    seller: SELLER,
    buyer: BUYER,
    amountStroops: "100000000",
    secretHex: n.toString(16).padStart(64, "f"),
    secretHashHex: `hash${n}`,
    qrPayload: `qr${n}`,
    status: "pending_batch",
    createdAt: new Date().toISOString(),
    batchQueuedAt: new Date().toISOString(),
    ...overrides,
  };
  saveCashRequest(record);
  return record;
}

function post(app: any, trade_ids: unknown) {
  return app.inject({ method: "POST", url: URL, payload: { trade_ids } });
}

describe("POST /cash/batch-release", () => {
  let app: any;

  const buildApp = () => {
    const instance = Fastify();
    // The route never charges, but other cashRoutes handlers reference this
    // decorator, so it must exist for registration to succeed.
    instance.decorate("requirePayment", async () => true);
    // app.ts installs this globally; a bare Fastify() needs it so thrown
    // ApiErrors become their intended 4xx responses instead of a blanket 500.
    instance.setErrorHandler((error: any, request: any, reply: any) => {
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send(error.toJSON(request.id));
      }
      return reply
        .status(error.statusCode ?? 500)
        .send({ error: error.message });
    });
    instance.register(cashRoutes, { prefix: "/api/v1" });
    return instance;
  };

  beforeEach(() => {
    clearStore();
    clearNotificationQueue();
    (releaseBatchAtomic as any).mockReset();
    (releaseBatchAtomic as any).mockResolvedValue(undefined);
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("atomically releases a same-seller batch in a single transaction", async () => {
    const t1 = makeTrade(1, { amountStroops: "500000000" });
    const t2 = makeTrade(2, { amountStroops: "300000000" });
    const t3 = makeTrade(3, { amountStroops: "200000000" });

    const res = await post(app, [t1.id, t2.id, t3.id]);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      released_count: 3,
      total_amount: "1000000000",
    });

    // One on-chain invocation settles the whole batch, with every leg's
    // secret handed to the atomic entrypoint in order.
    expect(releaseBatchAtomic).toHaveBeenCalledTimes(1);
    expect(releaseBatchAtomic).toHaveBeenCalledWith({
      contractId: CONTRACT,
      releases: [
        { tradeId: t1.id, secretHex: t1.secretHex },
        { tradeId: t2.id, secretHex: t2.secretHex },
        { tradeId: t3.id, secretHex: t3.secretHex },
      ],
    });

    for (const t of [t1, t2, t3]) {
      expect(getCashRequest(t.id)?.status).toBe("released");
    }
  });

  it("rolls back the whole batch when one leg fails, leaving every trade pending", async () => {
    const trades = [makeTrade(1), makeTrade(2), makeTrade(3)];
    // release_batch() reverts if any single secret is invalid, so the
    // contract call rejects rather than partially settling.
    (releaseBatchAtomic as any).mockRejectedValueOnce(
      new Error("HostError: Error(Contract, #4) InvalidSecret"),
    );

    const res = await post(app, trades.map((t) => t.id));

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("batch release failed");
    expect(releaseBatchAtomic).toHaveBeenCalledTimes(1);

    // No partial settlement: not one trade was marked released.
    for (const t of trades) {
      expect(getCashRequest(t.id)?.status).toBe("pending_batch");
    }
  });

  it("surfaces an RPC timeout as 504 without settling anything", async () => {
    const trades = [makeTrade(1), makeTrade(2)];
    (releaseBatchAtomic as any).mockRejectedValueOnce(
      new RpcTimeoutError("batch_release", 30_000),
    );

    const res = await post(app, trades.map((t) => t.id));

    expect(res.statusCode).toBe(504);
    expect(res.json().error).toBe("rpc_timeout");
    for (const t of trades) {
      expect(getCashRequest(t.id)?.status).toBe("pending_batch");
    }
  });

  it("rejects an empty batch", async () => {
    const res = await post(app, []);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("EMPTY_BATCH");
    expect(releaseBatchAtomic).not.toHaveBeenCalled();
  });

  it("rejects a batch larger than the contract cap of 25", async () => {
    const ids = Array.from({ length: 26 }, (_, i) => tradeId(i + 1));

    const res = await post(app, ids);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("BATCH_TOO_LARGE");
    expect(releaseBatchAtomic).not.toHaveBeenCalled();
  });

  it("rejects a batch referencing an unknown trade id", async () => {
    const known = makeTrade(1);

    const res = await post(app, [known.id, tradeId(999)]);

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("TRADE_NOT_FOUND");
    expect(releaseBatchAtomic).not.toHaveBeenCalled();
    expect(getCashRequest(known.id)?.status).toBe("pending_batch");
  });

  it("rejects a batch containing a trade that is not pending_batch", async () => {
    const t1 = makeTrade(1);
    const t2 = makeTrade(2, { status: "locked", batchQueuedAt: undefined });

    const res = await post(app, [t1.id, t2.id]);

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("INVALID_STATUS");
    expect(releaseBatchAtomic).not.toHaveBeenCalled();
  });

  it("rejects a batch whose trades belong to different sellers", async () => {
    const t1 = makeTrade(1);
    const t2 = makeTrade(2, { seller: SELLER_2 });

    const res = await post(app, [t1.id, t2.id]);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("MIXED_SELLERS");
    expect(releaseBatchAtomic).not.toHaveBeenCalled();
  });

  it("rejects a batch spanning multiple contracts", async () => {
    const t1 = makeTrade(1);
    const t2 = makeTrade(2, { contractId: CONTRACT_2 });

    const res = await post(app, [t1.id, t2.id]);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("MIXED_CONTRACTS");
    expect(releaseBatchAtomic).not.toHaveBeenCalled();
  });

  it("rejects a batch whose trade is missing its revealed secret", async () => {
    const t1 = makeTrade(1, { secretHex: "" });

    const res = await post(app, [t1.id]);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("MISSING_SECRET");
    expect(releaseBatchAtomic).not.toHaveBeenCalled();
  });
});
