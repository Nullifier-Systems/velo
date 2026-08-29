import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const alerts = vi.hoisted(() => ({
  secretExtracted: vi.fn(),
  refundClaimed: vi.fn(),
  expiryWarning: vi.fn(),
}));

vi.mock("../webhook.js", () => ({
  sendSwapSecretExtractedAlert: alerts.secretExtracted,
  sendSwapRefundClaimedAlert: alerts.refundClaimed,
  sendSwapExpiryWarningAlert: alerts.expiryWarning,
}));

const { SwapDisputeStore } = await import("../swapDisputeStore.js");
const { runSwapDisputeTick, warnOnApproachingExpiry } = await import(
  "./swapDisputeWorker.js"
);

const SWAP_ID = "b".repeat(64);
const INITIATOR = `GINITIATOR${"X".repeat(46)}`.slice(0, 56);
const COUNTERPARTY = `GCOUNTER${"X".repeat(48)}`.slice(0, 56);
const EXPIRATION_LEDGER = 1_000;

const PREIMAGE = "44".repeat(32);
const SECRET_HASH = createHash("sha256")
  .update(Buffer.from(PREIMAGE, "hex"))
  .digest("hex");

async function makeStore() {
  const store = new SwapDisputeStore();
  await store.registerSwap({
    swapId: SWAP_ID,
    initiatorAddress: INITIATOR,
    counterpartyAddress: COUNTERPARTY,
    secretHash: SECRET_HASH,
    expirationLedger: EXPIRATION_LEDGER,
  });
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("swap dispute worker", () => {
  it("extracts a revealed preimage and alerts once", async () => {
    const store = await makeStore();

    const summary = await runSwapDisputeTick({
      store,
      getLedger: async () => EXPIRATION_LEDGER - 100,
      pollReveals: async () => [
        { swapId: SWAP_ID, preimageHex: PREIMAGE, source: "stellar" },
      ],
    });

    expect(summary.secretsExtracted).toBe(1);
    expect(alerts.secretExtracted).toHaveBeenCalledTimes(1);

    const bridge = await store.getBridge(SWAP_ID);
    expect(bridge?.state).toBe("SECRET_EXTRACTED");
    expect(bridge?.secretPreimage).toBe(PREIMAGE);
  });

  it("does not re-alert for a preimage it already stored", async () => {
    const store = await makeStore();
    const options = {
      store,
      getLedger: async () => EXPIRATION_LEDGER - 100,
      pollReveals: async () => [
        { swapId: SWAP_ID, preimageHex: PREIMAGE, source: "stellar" as const },
      ],
    };

    await runSwapDisputeTick(options);
    const second = await runSwapDisputeTick(options);

    expect(second.secretsExtracted).toBe(0);
    expect(alerts.secretExtracted).toHaveBeenCalledTimes(1);
  });

  it("claims a refund for an expired swap and marks it resolved", async () => {
    const store = await makeStore();
    const submitRefund = vi.fn(async () => "tx-hash-1");

    const summary = await runSwapDisputeTick({
      store,
      getLedger: async () => EXPIRATION_LEDGER + 1,
      pollReveals: async () => [],
      submitRefund,
    });

    expect(summary.refundsClaimed).toBe(1);
    expect(submitRefund).toHaveBeenCalledTimes(1);
    expect(alerts.refundClaimed).toHaveBeenCalledTimes(1);
    expect((await store.getBridge(SWAP_ID))?.state).toBe("RESOLVED");
  });

  it("does not refund a swap that is not yet expired", async () => {
    const store = await makeStore();
    const submitRefund = vi.fn(async () => null);

    const summary = await runSwapDisputeTick({
      store,
      getLedger: async () => EXPIRATION_LEDGER - 1,
      pollReveals: async () => [],
      submitRefund,
    });

    expect(summary.refundsClaimed).toBe(0);
    expect(submitRefund).not.toHaveBeenCalled();
  });

  it("never refunds a swap whose secret landed in the same tick", async () => {
    // The ordering guarantee: a reveal seen alongside an expiry must win, or
    // the funds go back while the counterparty can still take the other leg.
    const store = await makeStore();
    const submitRefund = vi.fn(async () => null);

    const summary = await runSwapDisputeTick({
      store,
      getLedger: async () => EXPIRATION_LEDGER + 5,
      pollReveals: async () => [
        { swapId: SWAP_ID, preimageHex: PREIMAGE, source: "evm" },
      ],
      submitRefund,
    });

    expect(summary.secretsExtracted).toBe(1);
    expect(summary.refundsClaimed).toBe(0);
    expect(submitRefund).not.toHaveBeenCalled();
    expect((await store.getBridge(SWAP_ID))?.state).toBe("SECRET_EXTRACTED");
  });

  it("keeps processing the batch when one reveal is bad", async () => {
    const store = await makeStore();
    const onError = vi.fn();

    const summary = await runSwapDisputeTick({
      store,
      getLedger: async () => EXPIRATION_LEDGER - 100,
      pollReveals: async () => [
        // Unknown swap — must not abort the rest of the batch.
        { swapId: "f".repeat(64), preimageHex: PREIMAGE, source: "stellar" },
        { swapId: SWAP_ID, preimageHex: PREIMAGE, source: "stellar" },
      ],
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(summary.secretsExtracted).toBe(1);
  });

  it("reports an error rather than storing a preimage that does not hash", async () => {
    const store = await makeStore();
    const onError = vi.fn();

    const summary = await runSwapDisputeTick({
      store,
      getLedger: async () => EXPIRATION_LEDGER - 100,
      pollReveals: async () => [
        { swapId: SWAP_ID, preimageHex: "99".repeat(32), source: "evm" },
      ],
      onError,
    });

    expect(summary.secretsExtracted).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((await store.getBridge(SWAP_ID))?.secretPreimage).toBeNull();
  });

  it("warns only for live swaps inside the expiry margin", async () => {
    const store = await makeStore();
    const bridge = await store.getBridge(SWAP_ID);
    expect(bridge).not.toBeNull();

    // Far from expiry: no warning.
    expect(await warnOnApproachingExpiry([bridge!], EXPIRATION_LEDGER - 500)).toBe(0);

    // Inside the margin: one warning.
    expect(await warnOnApproachingExpiry([bridge!], EXPIRATION_LEDGER - 10)).toBe(1);
    expect(alerts.expiryWarning).toHaveBeenCalledTimes(1);

    // Already expired is the refund path's business, not a warning.
    expect(await warnOnApproachingExpiry([bridge!], EXPIRATION_LEDGER + 1)).toBe(0);
  });

  it("does not warn about a swap whose secret is already stored", async () => {
    const store = await makeStore();
    await store.recordSecret(SWAP_ID, PREIMAGE);
    const bridge = await store.getBridge(SWAP_ID);

    expect(await warnOnApproachingExpiry([bridge!], EXPIRATION_LEDGER - 10)).toBe(0);
    expect(alerts.expiryWarning).not.toHaveBeenCalled();
  });
});
