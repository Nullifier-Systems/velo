export interface AuditLogEvent {
    sequenceId: string;
    eventType: string;
    payloadHash: string;
    prevHash: string;
    currHash: string;
    createdAt: string;
}

export interface AuditInclusionProof {
    eventId: string;
    merkleRoot: string;
    proof: string[];
    leafIndex: number;
    stellarTxHash?: string;
    verified: boolean;
}
