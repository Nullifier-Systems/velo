import { scValToNative, xdr } from "@stellar/stellar-sdk";

type EncodedScVal = xdr.ScVal | string;

export type EscrowEventType = "locked" | "released" | "disputed";

export interface IndexedEscrowEvent {
  eventId: string;
  contractId: string;
  ledger: number;
  order: number;
  transactionHash?: string;
  type: EscrowEventType;
  escrowId: string;
  amount?: string;
  actor?: string;
  raw: unknown;
}

function native(value: EncodedScVal): unknown {
  const decoded = typeof value === "string"
    ? xdr.ScVal.fromXDR(value, "base64")
    : value;
  return scValToNative(decoded);
}

function bytesHex(value: unknown): string | null {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.from(value).toString("hex");
  }
  return null;
}

function integerString(value: unknown): string | undefined {
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  return undefined;
}

/** Decode the exact events emitted by contracts/escrow/src/lib.rs. */
export function decodeEscrowEvent(raw: any, order = 0): IndexedEscrowEvent | null {
  try {
    const topics: EncodedScVal[] = raw.topic ?? [];
    if (topics.length < 2) return null;
    const type = native(topics[0]);
    if (type !== "locked" && type !== "released" && type !== "disputed") return null;
    const escrowId = bytesHex(native(topics[1]));
    if (!escrowId) return null;

    const value = raw.value === undefined ? undefined : native(raw.value);
    const actorValue = type === "disputed" && Array.isArray(value) ? value[0] : undefined;
    const eventId = String(raw.id ?? raw.pagingToken ?? "");
    const contractId = String(raw.contractId ?? raw.contract_id ?? "");
    const ledger = Number(raw.ledger ?? raw.ledgerSequence ?? 0);
    if (!eventId || !contractId || !Number.isSafeInteger(ledger) || ledger < 0) return null;

    return {
      eventId,
      contractId,
      ledger,
      order,
      transactionHash: raw.txHash ?? raw.transactionHash,
      type,
      escrowId,
      amount: type === "disputed" ? undefined : integerString(value),
      actor: typeof actorValue === "string" ? actorValue : undefined,
      raw,
    };
  } catch {
    return null;
  }
}
