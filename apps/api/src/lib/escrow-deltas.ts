import { EventEmitter } from "node:events";

export interface EscrowDelta {
  contractId: string;
  escrowId: string;
  status: "locked" | "released" | "disputed";
  lockedAmount: string | null;
  releasedAmount: string | null;
  disputedBy: string | null;
  lastLedger: number;
}

class EscrowDeltaFeed {
  private readonly emitter = new EventEmitter();

  publish(delta: EscrowDelta): void {
    this.emitter.emit(`${delta.contractId}:${delta.escrowId}`, delta);
  }

  subscribe(contractId: string, escrowId: string, listener: (delta: EscrowDelta) => void): () => void {
    const topic = `${contractId}:${escrowId}`;
    this.emitter.on(topic, listener);
    return () => this.emitter.off(topic, listener);
  }
}

export const escrowDeltaFeed = new EscrowDeltaFeed();
