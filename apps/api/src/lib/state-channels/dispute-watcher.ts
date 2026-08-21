/**
 * State Channel Dispute Watcher
 * Monitors Stellar ledger for uncooperative close attempts and auto-submits penalty challenges.
 */

import { ApiError } from "../errors.js";

export interface DisputeWatcherConfig {
  db: any; // postgres client
  stellarServer: any; // Stellar Horizon server
  contractId: string; // State channel contract address
  pollIntervalMs: number; // How often to poll ledger (default: 30s)
}

export class DisputeWatcher {
  private db: any;
  private stellarServer: any;
  private contractId: string;
  private pollIntervalMs: number;
  private isRunning = false;
  private pollTimer?: NodeJS.Timeout;

  constructor(config: DisputeWatcherConfig) {
    this.db = config.db;
    this.stellarServer = config.stellarServer;
    this.contractId = config.contractId;
    this.pollIntervalMs = config.pollIntervalMs || 30000;
  }

  /**
   * Start the watcher background polling.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.poll();
  }

  /**
   * Stop the watcher.
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Poll the ledger for uncooperative close attempts.
   */
  private poll(): void {
    if (!this.isRunning) {
      return;
    }

    this.checkForDisputes()
      .catch((err) => {
        console.error("Dispute watcher error:", err);
      })
      .finally(() => {
        this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
      });
  }

  /**
   * Check for channel disputes and auto-submit challenges.
   */
  private async checkForDisputes(): Promise<void> {
    // Query for channels in CLOSING state (dispute window active)
    const closingChannels = await this.db`
      SELECT * FROM state_channels
      WHERE status = 'CLOSING'
      AND updated_at > NOW() - INTERVAL '24 hours'
    `;

    for (const channel of closingChannels) {
      await this.processDisputeForChannel(channel);
    }
  }

  /**
   * Process a single channel that's in dispute.
   * Checks for newer evidence and auto-submits challenge if found.
   */
  private async processDisputeForChannel(channel: any): Promise<void> {
    try {
      // Get the latest committed state for this channel
      const latestCommit = await this.db`
        SELECT * FROM state_channel_commits
        WHERE channel_id = ${channel.channel_id}
        ORDER BY sequence_number DESC
        LIMIT 1
      `;

      if (latestCommit.length === 0) {
        // No commits yet, nothing to challenge
        return;
      }

      const latest = latestCommit[0];

      // Check if there's evidence of an earlier state being submitted
      // (This would be tracked in the audit log by off-chain monitoring)
      const auditLogs = await this.db`
        SELECT * FROM state_channel_audit_log
        WHERE channel_id = ${channel.channel_id}
        AND event_type = 'UNCOOPERATIVE_CLOSE_ATTEMPT'
        AND status = 'PENDING'
      `;

      for (const audit of auditLogs) {
        // We have evidence that an older state was submitted
        // Submit on-chain challenge with newer evidence
        await this.submitPenaltyChallenge(
          channel,
          audit.challenged_sequence,
          latest.sequence_number,
          latest.signature,
          latest.state_root,
        );

        // Mark audit as resolved
        await this.db`
          UPDATE state_channel_audit_log
          SET status = 'RESOLVED', resolved_at = NOW()
          WHERE audit_id = ${audit.audit_id}
        `;
      }
    } catch (err) {
      console.error(
        `Error processing dispute for channel ${channel.channel_id}:`,
        err,
      );
    }
  }

  /**
   * Submit a penalty challenge transaction to Stellar.
   */
  private async submitPenaltyChallenge(
    channel: any,
    challengedSequence: bigint,
    evidenceSequence: bigint,
    evidenceSignature: string,
    evidenceRoot: string,
  ): Promise<void> {
    try {
      // Construct Soroban contract invocation to challenge_outdated_state
      // This is pseudocode; actual implementation depends on Soroban SDK
      const challengeTxn = {
        contractId: this.contractId,
        function: "challenge_outdated_state",
        args: [
          channel.channel_id,
          challengedSequence,
          evidenceSequence,
          evidenceSignature,
          evidenceRoot,
        ],
      };

      // Submit transaction to network
      // In production, this would be signed by a dispute relayer account
      // and submitted via Stellar SDK
      console.log(
        `Submitting penalty challenge for channel ${channel.channel_id}: ` +
          `challenged_seq=${challengedSequence}, evidence_seq=${evidenceSequence}`,
      );

      // TODO: Implement actual transaction submission via Stellar SDK
      // For now, log the attempt
      await this.db`
        INSERT INTO state_channel_audit_log (
          channel_id, event_type, challenger, challenged_sequence,
          evidence_root, penalty_amount, status
        )
        VALUES (
          ${channel.channel_id},
          'PENALTY_CHALLENGE_SUBMITTED',
          'system-watcher',
          ${challengedSequence},
          ${evidenceRoot},
          ${channel.total_deposit_stroops},
          'PENDING'
        )
      `;
    } catch (err) {
      console.error(
        `Failed to submit penalty challenge for channel ${channel.channel_id}:`,
        err,
      );
      throw err;
    }
  }
}

/**
 * Factory function to create and start a dispute watcher.
 */
export async function createDisputeWatcher(
  config: DisputeWatcherConfig,
): Promise<DisputeWatcher> {
  const watcher = new DisputeWatcher(config);
  watcher.start();
  return watcher;
}
