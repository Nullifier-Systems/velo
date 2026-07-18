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
    qrPayload: string; // safe to persist — contains no secret, only request_id + contract
    status: "locked" | "released" | "refunded" | "pending_signature";
    createdAt: string;
    notificationType?: "email" | "sms" | "none";
    contactInfo?: string;
}

export interface ProviderRecord {
    id: string;
    name: string;
    lat: number;
    lng: number;
    tier: string;
    rate: string;
    status: "available" | "unavailable";
    createdAt: string;
}

const store = new Map<string, CashRequestRecord>();
const providersStore = new Map<string, ProviderRecord>();

export function saveCashRequest(record: CashRequestRecord) {
    store.set(record.id, record);
}

export function saveProvider(record: ProviderRecord) {
    providersStore.set(record.id, record);
}

export function getProviders(): ProviderRecord[] {
    return Array.from(providersStore.values());
}

export function getCashRequest(id: string): CashRequestRecord | undefined {
    return store.get(id);
}

export function updateStatus(id: string, status: CashRequestRecord["status"]) {
    const record = store.get(id);
    if (record) record.status = status;
}

export function getProviderTrades(sellerAddress: string): CashRequestRecord[] {
    return Array.from(store.values()).filter(
        record => record.seller === sellerAddress
    );
}

export function getStoreStats() {
    const requests = Array.from(store.values());
    return {
        total_cash_requests: store.size,
        total_providers: providersStore.size,
        cash_requests_by_status: {
            locked: requests.filter(r => r.status === "locked").length,
            released: requests.filter(r => r.status === "released").length,
            refunded: requests.filter(r => r.status === "refunded").length,
            pending_signature: requests.filter(r => r.status === "pending_signature").length,
        },
    };
}