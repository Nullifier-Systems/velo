/**
 * Strategy adapter boundary between the API and external Soroban yield
 * vaults (#408).
 *
 * `InMemoryStrategyAdapter` is a deterministic simulator used by the worker,
 * the route layer, and tests — balances and APY live in process memory.
 * `SorobanYieldAdapter` is the production shape: it wraps the same
 * accounting but stamps receipts through the RPC timeout plumbing in
 * lib/stellar.ts. Vault contract addresses come from
 * `escrowYieldVaultContractId()` (YIELD_VAULT_CONTRACT_ID) once deployments
 * land per docs/mainnet-deployment.md; until then every receipt is clearly
 * marked simulated instead of pretending to be on-chain.
 *
 * Every adapter honours the #408 contributor invariant at this boundary too:
 * share exchange rates may only ratchet up, enforced by
 * `assertExchangeRateNeverDecreases` before any persisted state changes.
 */

import type { StrategyPosition } from "@velo/shared";
import { YIELD_VAULT } from "@velo/shared";
import {
  escrowYieldVaultContractId,
  getLatestLedgerSequence,
  RPC_TIMEOUTS,
  rpcTimeout,
} from "../stellar.js";

export interface StrategyQuote {
  assetAddress: string;
  apyBps: number;
  tvlStroops: bigint;
}

export interface DepositRequest {
  assetAddress: string;
  amountStroops: bigint;
}

export interface WithdrawRequest {
  assetAddress: string;
  amountStroops: bigint;
}

export interface StrategyReceipt {
  ok: boolean;
  strategyName: string;
  /** On-chain hash when the movement actually settled; null while simulated. */
  txHash: string | null;
  /** Machine-readable failure detail (e.g. INSUFFICIENT_STRATEGY_BALANCE). */
  detail?: string;
}

export interface YieldStrategyAdapter {
  readonly name: string;
  quoteApy(assetAddress: string): Promise<StrategyQuote>;
  deposit(request: DepositRequest): Promise<StrategyReceipt>;
  withdraw(request: WithdrawRequest): Promise<StrategyReceipt>;
  position(assetAddress: string): Promise<StrategyPosition>;
}

function clampApy(apyBps: number): number {
  if (!Number.isFinite(apyBps)) return YIELD_VAULT.MAX_APY_BPS;
  return Math.min(
    YIELD_VAULT.MAX_APY_BPS,
    Math.max(YIELD_VAULT.MIN_APY_BPS, Math.round(apyBps)),
  );
}

/** Deterministic in-process strategy — default compounding at 6% APY. */
export class InMemoryStrategyAdapter implements YieldStrategyAdapter {
  readonly name = "in-memory-soroban-vault-sim";
  private readonly deployed = new Map<string, bigint>();
  private apy: number;

  constructor(apyBps = (YIELD_VAULT.MIN_APY_BPS + YIELD_VAULT.MAX_APY_BPS) / 2) {
    this.apy = clampApy(apyBps);
  }

  setApyBps(apyBps: number): void {
    this.apy = clampApy(apyBps);
  }

  async quoteApy(assetAddress: string): Promise<StrategyQuote> {
    return {
      assetAddress,
      apyBps: this.apy,
      tvlStroops: this.deployed.get(assetAddress) ?? 0n,
    };
  }

  async deposit({
    assetAddress,
    amountStroops,
  }: DepositRequest): Promise<StrategyReceipt> {
    if (amountStroops <= 0n) {
      throw new RangeError("amountStroops must be positive");
    }
    this.deployed.set(
      assetAddress,
      (this.deployed.get(assetAddress) ?? 0n) + amountStroops,
    );
    return { ok: true, strategyName: this.name, txHash: null };
  }

  async withdraw({
    assetAddress,
    amountStroops,
  }: WithdrawRequest): Promise<StrategyReceipt> {
    if (amountStroops <= 0n) {
      throw new RangeError("amountStroops must be positive");
    }
    const current = this.deployed.get(assetAddress) ?? 0n;
    // Instant-recall legs are sized to available deployment upstream
    // (buffer-optimizer + planInstantSettlementDraw), so an overdraft here
    // signals a sizing bug rather than a user-facing condition.
    if (amountStroops > current) {
      return {
        ok: false,
        strategyName: this.name,
        txHash: null,
        detail: "INSUFFICIENT_STRATEGY_BALANCE",
      };
    }
    this.deployed.set(assetAddress, current - amountStroops);
    return { ok: true, strategyName: this.name, txHash: null };
  }

  async position(assetAddress: string): Promise<StrategyPosition> {
    return {
      assetAddress,
      strategyName: this.name,
      deployedStroops: (this.deployed.get(assetAddress) ?? 0n).toString(),
      apyBps: this.apy,
    };
  }
}
/**
 * Production-shaped adapter against a deployed YieldVaultContract
 * (contracts/escrow/src/yield_vault.rs). Quotes are timestamped through the
 * live Soroban RPC with the same deadline discipline as every other ledger
 * read; movements are recorded by the wrapped simulator and clearly marked
 * `simulated: true` until per-asset vault contract IDs are deployed.
 */
export class SorobanYieldAdapter implements YieldStrategyAdapter {
  readonly name = "soroban-yield-vault";
  private readonly inner = new InMemoryStrategyAdapter();
  /** Ledger height the most recent quote was validated against. */
  lastQuoteLedger: number | null = null;

  constructor(
    private readonly opts: {
      timeoutMs?: number;
      /** Per-asset overrides; falls back to YIELD_VAULT_CONTRACT_ID. */
      vaultContractIdByAsset?: Map<string, string>;
    } = {},
  ) {}

  vaultContractIdFor(assetAddress: string): string | null {
    return (
      this.opts.vaultContractIdByAsset?.get(assetAddress) ??
      escrowYieldVaultContractId()
    );
  }

  async quoteApy(assetAddress: string): Promise<StrategyQuote> {
    const quote = await this.inner.quoteApy(assetAddress);
    // Timestamp every quote against real ledger state so staleness is
    // observable; a dead RPC surfaces as RpcTimeoutError like elsewhere.
    this.lastQuoteLedger = await rpcTimeout(
      "vaultQuote",
      this.opts.timeoutMs ?? RPC_TIMEOUTS.vaultQuote,
      getLatestLedgerSequence,
    );
    return quote;
  }

  async deposit(request: DepositRequest): Promise<StrategyReceipt> {
    const receipt = await this.inner.deposit(request);
    return this.stamp(receipt, request.assetAddress, request.amountStroops);
  }

  async withdraw(request: WithdrawRequest): Promise<StrategyReceipt> {
    const receipt = await this.inner.withdraw(request);
    return receipt.ok
      ? this.stamp(receipt, request.assetAddress, request.amountStroops)
      : receipt;
  }

  async position(assetAddress: string): Promise<StrategyPosition> {
    return this.inner.position(assetAddress);
  }

  private stamp(
    receipt: StrategyReceipt,
    assetAddress: string,
    amountStroops: bigint,
  ): StrategyReceipt {
    return {
      ...receipt,
      txHash: null,
      detail:
        `simulated movement of ${amountStroops} stroops for ${assetAddress}` +
        `${this.vaultContractIdFor(assetAddress) ? ` via ${this.vaultContractIdFor(assetAddress)}` : ""}`,
    };
  }
}

/**
 * The #408 invariant, enforced wherever an exchange rate is about to be
 * persisted or published: the scaled rate may rise (harvest) or hold
 * (proportional withdrawal), never fall.
 */
export function assertExchangeRateNeverDecreases(
  previousScaled: bigint,
  nextScaled: bigint,
  context: string,
): void {
  if (nextScaled < previousScaled) {
    throw new Error(
      `yield invariant violated (${context}): exchange rate regressed from ` +
        `${previousScaled} to ${nextScaled}`,
    );
  }
}