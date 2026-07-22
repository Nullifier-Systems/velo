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
    status: "locked" | "released" | "refunded" | "disputed" | "pending_signature" | "pending_batch";
    createdAt: string;
    disputedAt?: string;
    disputedBy?: string;
    disputeReason?: string;
    resolvedAt?: string;
    resolvedBy?: string;
    resolution?: string;
    notificationType?: "email" | "sms" | "none";
    contactInfo?: string;
    // Set when the trade enters "pending_batch" — the secret revealed at
    // hand-off, held server-side only until the provider's next batch
    // fires. See docs/provider-payout-batching.md for the tradeoff this
    // implies (the API already sees this secret in the custodial release
    // flow either way; batching just holds it a little longer).
    batchQueuedAt?: string;
}

export interface ProviderRecord {
    id: string;
    stellarAddress?: string;
    name: string;
    lat: number;
    lng: number;
    tier: "Probationary" | "Standard" | "Trusted";
    rate: string;
    status: "available" | "unavailable";
    availability?: "available" | "unavailable";
    kycStatus: "pending" | "approved" | "rejected";
    ipAddress?: string;
    deviceId?: string;
    createdAt: string;
    // Opt-in payout batching (see docs/provider-payout-batching.md).
    // Default "immediate" preserves today's per-trade release() behavior.
    payoutMode?: "immediate" | "batched";
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

export function getProviderByAddress(stellarAddress: string): ProviderRecord | undefined {
    for (const record of providersStore.values()) {
        if (record.stellarAddress === stellarAddress) {
            return record;
        }
    }
    return undefined;
}

export function getProviderById(id: string): ProviderRecord | undefined {
    return providersStore.get(id);
}

export function setProviderVerificationStatus(
    id: string,
    status: ProviderRecord["kycStatus"]
): ProviderRecord | undefined {
    const record = providersStore.get(id);
    if (record) record.kycStatus = status;
    return record;
}

export function countProvidersByNetwork(ipAddress?: string, deviceId?: string): number {
    let count = 0;
    for (const record of providersStore.values()) {
        if ((ipAddress && record.ipAddress === ipAddress) || 
            (deviceId && record.deviceId === deviceId)) {
            count++;
        }
    }
    return count;
}

export function getCashRequest(id: string): CashRequestRecord | undefined {
    return store.get(id);
}

export function getAllCashRequests(): CashRequestRecord[] {
    return Array.from(store.values());
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

export function setProviderPayoutMode(
    stellarAddress: string,
    payoutMode: "immediate" | "batched"
): ProviderRecord | undefined {
    const record = getProviderByAddress(stellarAddress);
    if (record) record.payoutMode = payoutMode;
    return record;
}

/**
 * Queues a trade for batched settlement: stores the revealed secret and
 * flips status to "pending_batch". Only valid from "locked" — mirrors the
 * precondition the immediate release() path already enforces.
 */
export function enqueueForBatch(id: string, secretHex: string): CashRequestRecord | undefined {
    const record = store.get(id);
    if (!record || record.status !== "locked") return undefined;
    record.secretHex = secretHex;
    record.status = "pending_batch";
    record.batchQueuedAt = new Date().toISOString();
    return record;
}

/** All trades currently queued for batched settlement, oldest first. */
export function getPendingBatchTrades(): CashRequestRecord[] {
    return Array.from(store.values())
        .filter(record => record.status === "pending_batch")
        .sort((a, b) => new Date(a.batchQueuedAt ?? a.createdAt).getTime() - new Date(b.batchQueuedAt ?? b.createdAt).getTime());
}

/** Pending-batch trades grouped by seller (provider) address. */
export function getPendingBatchesByProvider(): Map<string, CashRequestRecord[]> {
    const grouped = new Map<string, CashRequestRecord[]>();
    for (const record of getPendingBatchTrades()) {
        const list = grouped.get(record.seller) ?? [];
        list.push(record);
        grouped.set(record.seller, list);
    }
    return grouped;
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
            disputed: requests.filter(r => r.status === "disputed").length,
            pending_signature: requests.filter(r => r.status === "pending_signature").length,
            pending_batch: requests.filter(r => r.status === "pending_batch").length,
        },
    };
}

export interface RecentActivityItem {
    id: string;
    status: CashRequestRecord["status"];
    createdAt: string;
}

/**
 * Sanitized feed of the most recent trades for the public status page.
 *
 * Deliberately omits seller/buyer addresses, amounts, and secret material —
 * only the trade id (already public via /claim/:id links), its status, and
 * its timestamp. This gives a rough sense of on-chain activity without
 * letting anyone enumerate counterparty addresses or trade sizes.
 *
 * Kept separate from getStoreStats() above: that one is for internal/admin
 * metrics (aggregate counts, behind ADMIN_API_KEY), this one is the public
 * transparency feed with no auth and no aggregate/sensitive fields.
 */
export function getRecentActivity(limit = 10): RecentActivityItem[] {
    return Array.from(store.values())
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit)
        .map(({ id, status, createdAt }) => ({ id, status, createdAt }));
}
