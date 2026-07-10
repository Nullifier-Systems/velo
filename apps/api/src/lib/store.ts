/**
 * In-memory store for pending/settled cash requests.
 *
 * TODO (production): replace with a real database. This resets on every
 * server restart and does not scale past a single process — it exists
 * only to prove the lock -> release flow end-to-end over HTTP.
 */
export interface CashRequestRecord {
    id: string; // trade id, hex
    contractId: string;
    seller: string;
    buyer: string;
    amountStroops: string; // bigint as string, JSON-safe
    secretHex: string; // TODO: don't store server-side long-term — see note below
    secretHashHex: string;
    status: "locked" | "released" | "refunded";
    createdAt: string;
}

const store = new Map<string, CashRequestRecord>();

export function saveCashRequest(record: CashRequestRecord) {
    store.set(record.id, record);
}

export function getCashRequest(id: string): CashRequestRecord | undefined {
    return store.get(id);
}

export function updateStatus(id: string, status: CashRequestRecord["status"]) {
    const record = store.get(id);
    if (record) record.status = status;
}