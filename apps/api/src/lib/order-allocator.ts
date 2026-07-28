import type { SpatialProvider } from "./h3-spatial-index.js";
import type { ScoredCandidate } from "./matching-engine.js";

export interface ProviderAllocationState {
  providerId: string;
  availableBalanceStroops: bigint;
  pendingQueueDepth: number;
  version: number;
}

export interface AllocationResult {
  success: boolean;
  matchedProvider?: SpatialProvider;
  score?: number;
  allocatedAmountStroops?: bigint;
  error?: string;
  attempts?: number;
}

/**
 * Optimistic Concurrency Control (OCC) Lock-Free Order Allocator.
 * Prevents over-committing provider balance under high concurrent load without blocking mutexes.
 */
export class LockFreeOrderAllocator {
  private providerStates: Map<string, ProviderAllocationState> = new Map();

  constructor() {}

  /**
   * Register or update initial provider allocation capacity.
   */
  public registerProviderCapacity(
    providerId: string,
    initialBalanceStroops: bigint = 1_000_000_000n // 100 USDC default
  ): void {
    if (!this.providerStates.has(providerId)) {
      this.providerStates.set(providerId, {
        providerId,
        availableBalanceStroops: initialBalanceStroops,
        pendingQueueDepth: 0,
        version: 1,
      });
    }
  }

  /**
   * Set exact provider balance capacity.
   */
  public setProviderBalance(providerId: string, balanceStroops: bigint): void {
    const state = this.providerStates.get(providerId);
    if (state) {
      state.availableBalanceStroops = balanceStroops;
      state.version += 1;
    } else {
      this.providerStates.set(providerId, {
        providerId,
        availableBalanceStroops: balanceStroops,
        pendingQueueDepth: 0,
        version: 1,
      });
    }
  }

  /**
   * Get provider allocation state.
   */
  public getProviderState(providerId: string): ProviderAllocationState | undefined {
    return this.providerStates.get(providerId);
  }

  /**
   * Optimistically attempt to allocate a cash request to top ranked candidates.
   * Uses lock-free Compare-And-Swap (CAS) on provider version.
   */
  public attemptAllocation(
    amountStroops: bigint,
    rankedCandidates: ScoredCandidate[]
  ): AllocationResult {
    if (rankedCandidates.length === 0) {
      return {
        success: false,
        error: "NO_PROVIDERS_AVAILABLE",
      };
    }

    let attempts = 0;

    for (const candidate of rankedCandidates) {
      attempts++;
      const providerId = candidate.provider.id;

      // Ensure state exists
      if (!this.providerStates.has(providerId)) {
        this.registerProviderCapacity(providerId);
      }

      const currentState = this.providerStates.get(providerId)!;

      // 1. Check balance constraint
      if (currentState.availableBalanceStroops < amountStroops) {
        continue; // Insufficient balance, try next ranked candidate
      }

      // Snapshot current version for CAS check
      const expectedVersion = currentState.version;

      // 2. Perform Lock-Free Compare-And-Swap (CAS)
      const currentSnapshot = this.providerStates.get(providerId);
      if (!currentSnapshot || currentSnapshot.version !== expectedVersion) {
        // CAS failed due to concurrent update, try re-evaluating candidate
        continue;
      }

      // Execute atomic state mutation
      currentSnapshot.availableBalanceStroops -= amountStroops;
      currentSnapshot.pendingQueueDepth += 1;
      currentSnapshot.version += 1;

      // Update provider object properties
      candidate.provider.availableBalanceStroops = currentSnapshot.availableBalanceStroops;
      candidate.provider.pendingQueueDepth = currentSnapshot.pendingQueueDepth;
      candidate.provider.version = currentSnapshot.version;

      return {
        success: true,
        matchedProvider: candidate.provider,
        score: candidate.score,
        allocatedAmountStroops: amountStroops,
        attempts,
      };
    }

    return {
      success: false,
      error: "INSUFFICIENT_PROVIDER_BALANCE",
      attempts,
    };
  }

  /**
   * Release reserved allocation (e.g. trade completed, refunded, or expired).
   */
  public releaseAllocation(providerId: string, amountStroops: bigint): void {
    const state = this.providerStates.get(providerId);
    if (state) {
      state.availableBalanceStroops += amountStroops;
      state.pendingQueueDepth = Math.max(0, state.pendingQueueDepth - 1);
      state.version += 1;
    }
  }

  /**
   * Clear all provider allocation states.
   */
  public clear(): void {
    this.providerStates.clear();
  }
}

export const globalOrderAllocator = new LockFreeOrderAllocator();
