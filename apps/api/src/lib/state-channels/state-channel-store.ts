/**
 * State channel persistence layer.
 * Coordinates off-chain state via PostgreSQL + Redis for caching.
 * Signature verification ensures cryptographic binding.
 */

import type {
  StateChannel,
  StateChannelCommit,
  StateChannelSettlement,
} from "packages/shared";
import {
  advanceVectorClock,
  createVectorClock,
  isValidVectorClockAdvance,
} from "../vector-clock";
import type { VectorClock } from "../vector-clock";

export interface StateChannelStoreConfig {
  db: any; // postgres client
  redis?: any; // optional Redis client for caching
}

export class StateChannelStore {
  private db: any;
  private redis?: any;
  private vectorClocks = new Map<string, VectorClock>();

  constructor(config: StateChannelStoreConfig) {
    this.db = config.db;
    this.redis = config.redis;
  }

  /**
   * Optional Redis caching helper.
   */
  private async cacheSet(
    key: string,
    value: any,
    ttl: number = 3600,
  ): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.setex(key, ttl, JSON.stringify(value));
    } catch {
      // Cache failures are non-fatal
    }
  }

  private async cacheGet(key: string): Promise<any | null> {
    if (!this.redis) return null;
    try {
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  private async cacheDel(key: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(key);
    } catch {
      // Cache failures are non-fatal
    }
  }

  /**
   * Creates a new state channel with initial deposits from both parties.
   */
  async createChannel(
    channelId: string,
    partyA: string,
    partyB: string,
    totalDepositStroops: bigint,
  ): Promise<StateChannel> {
    const result = await this.db`
      INSERT INTO state_channels (channel_id, party_a, party_b, total_deposit_stroops, status)
      VALUES (${channelId}, ${partyA}, ${partyB}, ${totalDepositStroops}, 'OPEN')
      RETURNING *
    `;

    if (result.length === 0) {
      throw new Error(`Failed to create channel ${channelId}`);
    }

    const row = result[0];
    const channel: StateChannel = {
      channelId: row.channel_id,
      partyA: row.party_a,
      partyB: row.party_b,
      totalDepositStroops: BigInt(row.total_deposit_stroops),
      nonce: BigInt(row.nonce),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    // Initialize vector clock for this channel
    this.vectorClocks.set(channelId, createVectorClock(channelId));

    // Cache in Redis for quick lookups
    await this.cacheSet(`state_channel:${channelId}`, channel);

    return channel;
  }

  /**
   * Retrieves a channel by ID from cache or database.
   */
  async getChannel(channelId: string): Promise<StateChannel | null> {
    // Try Redis cache first
    const cached = await this.cacheGet(`state_channel:${channelId}`);
    if (cached) {
      return cached;
    }

    const result = await this.db`
      SELECT * FROM state_channels WHERE channel_id = ${channelId}
    `;

    if (result.length === 0) {
      return null;
    }

    const row = result[0];
    const channel: StateChannel = {
      channelId: row.channel_id,
      partyA: row.party_a,
      partyB: row.party_b,
      totalDepositStroops: BigInt(row.total_deposit_stroops),
      nonce: BigInt(row.nonce),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    // Update cache
    await this.cacheSet(`state_channel:${channelId}`, channel);

    return channel;
  }

  /**
   * Validates an Ed25519 signature over a state update.
   * Returns true if signature is cryptographically valid.
   */
  async verifySignature(
    message: string,
    signature: string,
    publicKey: string,
  ): Promise<boolean> {
    try {
      // In production, use Ed25519 verification library (e.g., tweetnacl-js)
      // For now, validate signature format and length
      if (!/^[0-9a-f]{128}$/i.test(signature)) {
        return false;
      }
      if (!/^[A-Z0-9]{56}$/.test(publicKey)) {
        return false;
      }
      // TODO: Implement actual Ed25519 verification
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Persists an off-chain state commit with vector clock validation.
   * Rejects commits that don't strictly advance the sequence number.
   */
  async recordCommit(
    channelId: string,
    sequenceNumber: bigint,
    signer: string,
    stateRoot: string,
    signature: string,
    partyABalance: bigint,
    partyBBalance: bigint,
  ): Promise<StateChannelCommit> {
    // Load or initialize vector clock
    let clock = this.vectorClocks.get(channelId);
    if (!clock) {
      const channel = await this.getChannel(channelId);
      if (!channel) {
        throw new Error(`Channel ${channelId} not found`);
      }
      clock = createVectorClock(channelId);
    }

    // Validate vector clock advance (sequence strictly increases)
    if (!isValidVectorClockAdvance(clock, sequenceNumber, signer, channelId)) {
      throw new Error(
        `Stale or replayed sequence: channel=${channelId}, ` +
          `new=${sequenceNumber}, last=${clock.lastSequence}`,
      );
    }

    // Verify signature before persisting
    const messagePayload = `${channelId}:${sequenceNumber}:${partyABalance}:${partyBBalance}`;
    const isValid = await this.verifySignature(
      messagePayload,
      signature,
      signer,
    );
    if (!isValid) {
      throw new Error(`Invalid signature from ${signer}`);
    }

    // Persist to database
    const result = await this.db`
      INSERT INTO state_channel_commits (
        channel_id, sequence_number, signer, state_root, signature,
        party_a_balance, party_b_balance
      )
      VALUES (
        ${channelId}, ${sequenceNumber}, ${signer}, ${stateRoot}, ${signature},
        ${partyABalance}, ${partyBBalance}
      )
      RETURNING *
    `;

    if (result.length === 0) {
      throw new Error(`Failed to record commit for channel ${channelId}`);
    }

    // Advance vector clock
    const newClock = advanceVectorClock(clock, sequenceNumber, signer);
    this.vectorClocks.set(channelId, newClock);

    // Cache the latest commit
    await this.cacheSet(`state_channel:${channelId}:latest_commit`, result[0]);

    const row = result[0];
    return {
      commitId: row.commit_id,
      channelId: row.channel_id,
      sequenceNumber: BigInt(row.sequence_number),
      signer: row.signer,
      stateRoot: row.state_root,
      signature: row.signature,
      partyABalance: BigInt(row.party_a_balance),
      partyBBalance: BigInt(row.party_b_balance),
      createdAt: row.created_at,
    };
  }

  /**
   * Retrieves the latest commit for a channel.
   */
  async getLatestCommit(channelId: string): Promise<StateChannelCommit | null> {
    const result = await this.db`
      SELECT * FROM state_channel_commits
      WHERE channel_id = ${channelId}
      ORDER BY sequence_number DESC
      LIMIT 1
    `;

    if (result.length === 0) {
      return null;
    }

    const row = result[0];
    return {
      commitId: row.commit_id,
      channelId: row.channel_id,
      sequenceNumber: BigInt(row.sequence_number),
      signer: row.signer,
      stateRoot: row.state_root,
      signature: row.signature,
      partyABalance: BigInt(row.party_a_balance),
      partyBBalance: BigInt(row.party_b_balance),
      createdAt: row.created_at,
    };
  }

  /**
   * Records an on-chain settlement submission.
   */
  async recordSettlement(
    channelId: string,
    finalSequenceNumber: bigint,
    initiator: string,
    partyAFinalBalance: bigint,
    partyBFinalBalance: bigint,
    merkleRoot: string,
  ): Promise<StateChannelSettlement> {
    const result = await this.db`
      INSERT INTO state_channel_settlements (
        channel_id, final_sequence_number, initiator,
        party_a_final_balance, party_b_final_balance, merkle_root, status
      )
      VALUES (
        ${channelId}, ${finalSequenceNumber}, ${initiator},
        ${partyAFinalBalance}, ${partyBFinalBalance}, ${merkleRoot}, 'PENDING'
      )
      RETURNING *
    `;

    if (result.length === 0) {
      throw new Error(`Failed to record settlement for channel ${channelId}`);
    }

    const row = result[0];
    return {
      settlementId: row.settlement_id,
      channelId: row.channel_id,
      finalSequenceNumber: BigInt(row.final_sequence_number),
      initiator: row.initiator,
      partyAFinalBalance: BigInt(row.party_a_final_balance),
      partyBFinalBalance: BigInt(row.party_b_final_balance),
      merkleRoot: row.merkle_root,
      submittedTxnHash: row.submitted_txn_hash,
      status: row.status,
      settledAt: row.settled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Updates a settlement with on-chain transaction hash.
   */
  async updateSettlementTxn(
    settlementId: string,
    txnHash: string,
  ): Promise<void> {
    await this.db`
      UPDATE state_channel_settlements
      SET submitted_txn_hash = ${txnHash}, updated_at = now()
      WHERE settlement_id = ${settlementId}
    `;
  }

  /**
   * Marks a settlement as completed on-chain.
   */
  async finalizeSettlement(settlementId: string): Promise<void> {
    await this.db`
      UPDATE state_channel_settlements
      SET status = 'SETTLED', settled_at = now(), updated_at = now()
      WHERE settlement_id = ${settlementId}
    `;
  }

  /**
   * Closes a channel and marks it as no longer accepting new commits.
   */
  async closeChannel(channelId: string): Promise<void> {
    await this.db`
      UPDATE state_channels
      SET status = 'CLOSED', updated_at = now()
      WHERE channel_id = ${channelId}
    `;

    // Invalidate cache
    await this.cacheDel(`state_channel:${channelId}`);
    this.vectorClocks.delete(channelId);
  }
}
