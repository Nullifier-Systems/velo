/**
 * State Channel Manager
 * Coordinates channel lifecycle: creation, state updates, settlement coordination.
 */

import { StateChannelStore } from "./state-channel-store.js";
import type { StateChannel, StateChannelCommit } from "@velo/shared";

export interface ChannelManagerConfig {
  db: any;
  redis?: any;
  contractId: string;
}

export class ChannelManager {
  private store: StateChannelStore;
  private contractId: string;

  constructor(config: ChannelManagerConfig) {
    this.store = new StateChannelStore({ db: config.db, redis: config.redis });
    this.contractId = config.contractId;
  }

  /**
   * Initialize a new state channel between two parties.
   * Idempotent: creating the same channel twice returns the existing one.
   */
  async openChannel(
    channelId: string,
    partyA: string,
    partyB: string,
    totalDepositStroops: bigint,
  ): Promise<StateChannel> {
    // Check if channel already exists
    const existing = await this.store.getChannel(channelId);
    if (existing) {
      if (existing.status !== "OPEN") {
        throw new Error(
          `Channel ${channelId} is not open (status: ${existing.status})`,
        );
      }
      return existing;
    }

    // Create new channel
    return await this.store.createChannel(
      channelId,
      partyA,
      partyB,
      totalDepositStroops,
    );
  }

  /**
   * Record an off-chain state update from a participant.
   * Both parties must sign updates; sequence numbers must strictly increase.
   */
  async recordStateUpdate(
    channelId: string,
    sequenceNumber: bigint,
    signer: string,
    partyABalance: bigint,
    partyBBalance: bigint,
    signature: string,
  ): Promise<StateChannelCommit> {
    const channel = await this.store.getChannel(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`);
    }

    if (channel.status !== "OPEN") {
      throw new Error(
        `Channel ${channelId} is not open (status: ${channel.status})`,
      );
    }

    // Verify signer is one of the parties
    if (signer !== channel.partyA && signer !== channel.partyB) {
      throw new Error(`Signer ${signer} is not a party to this channel`);
    }

    // Verify balance conservation
    if (partyABalance + partyBBalance !== channel.totalDepositStroops) {
      throw new Error(
        `Balance mismatch: ${partyABalance} + ${partyBBalance} ≠ ${channel.totalDepositStroops}`,
      );
    }

    // Record the commit (vector clock validation happens inside store)
    return await this.store.recordCommit(
      channelId,
      sequenceNumber,
      signer,
      "", // stateRoot: computed during settlement
      signature,
      partyABalance,
      partyBBalance,
    );
  }

  /**
   * Propose a cooperative settlement.
   * Requires both parties to have signed the final state.
   */
  async proposeSettlement(
    channelId: string,
    finalSequenceNumber: bigint,
    partyAFinalBalance: bigint,
    partyBFinalBalance: bigint,
    merkleRoot: string,
  ): Promise<string> {
    const channel = await this.store.getChannel(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`);
    }

    if (channel.status !== "OPEN") {
      throw new Error(
        `Channel ${channelId} is not open (status: ${channel.status})`,
      );
    }

    // Verify the final state is consistent with latest commits
    const latestCommit = await this.store.getLatestCommit(channelId);
    if (!latestCommit) {
      throw new Error(`No commits found for channel ${channelId}`);
    }

    if (finalSequenceNumber < latestCommit.sequenceNumber) {
      throw new Error(
        `Final sequence ${finalSequenceNumber} is less than latest ${latestCommit.sequenceNumber}`,
      );
    }

    // Record settlement submission (on-chain submission happens separately)
    const settlement = await this.store.recordSettlement(
      channelId,
      finalSequenceNumber,
      "", // initiator: set by caller
      partyAFinalBalance,
      partyBFinalBalance,
      merkleRoot,
    );

    return settlement.settlementId;
  }

  /**
   * Mark a settlement as submitted on-chain with transaction hash.
   */
  async recordSettlementSubmission(
    settlementId: string,
    txnHash: string,
  ): Promise<void> {
    await this.store.updateSettlementTxn(settlementId, txnHash);
  }

  /**
   * Finalize a settlement after on-chain confirmation.
   */
  async finalizeSettlement(settlementId: string): Promise<void> {
    await this.store.finalizeSettlement(settlementId);
  }

  /**
   * Close a channel (after successful settlement).
   */
  async closeChannel(channelId: string): Promise<void> {
    await this.store.closeChannel(channelId);
  }

  /**
   * Get the current state of a channel.
   */
  async getChannel(channelId: string): Promise<StateChannel | null> {
    return await this.store.getChannel(channelId);
  }

  /**
   * Get the latest committed state for a channel.
   */
  async getLatestState(channelId: string): Promise<StateChannelCommit | null> {
    return await this.store.getLatestCommit(channelId);
  }
}
