# Data Retention Policy

**Document Status:** Active  
**Last Updated:** 2026-07-24  
**Applies to:** Velo API (`apps/api`), Redis infrastructure, and PostgreSQL database storage  

---

## 1. Overview and Purpose

Velo facilitates anonymous cash liquidity on Stellar by managing peer-to-peer HTLC escrows, real-time encrypted trade chat, and operator-assisted dispute resolution. In operating this service, the system accumulates data across three primary domains:

1. **Trade records** (persistent trade storage and provider metadata)
2. **Chat history** (in-trade messaging and ephemeral public key exchanges)
3. **Dispute evidence uploads** (user-submitted images supporting dispute resolution)

This document establishes a deliberate retention policy balancing debugging needs, auditability, and dispute resolution against user privacy expectations under data-minimization principles.

---

## 2. Data Inventory and Retention Schedule

| Data Category | Sensitive / PII Fields Included | Retention Window | End-of-Life Action | Operational & Legal Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **Trade Records** | Wallet addresses (`buyer`, `seller`), trade amounts, notification contact info (email/phone), IP addresses, device IDs | **Persistent** (Long-term / 7 years financial audit standard) | Secret hex purged upon release/refund; trade audit log retained | Essential for transaction history, financial/tax auditing, dispute tracing, and reputation score integrity (`reputation_events`). Non-sensitive metadata remains accessible. |
| **Chat History** *(High Sensitivity)* | Sender wallet address, E2E encrypted ciphertext (meeting spots, personal details), nonces, ephemeral X25519 public keys | **30 days** after trade finalization (`released` or `refunded`) | **Automated Hard Delete** | Contains user meeting arrangements and messaging traffic. Retained briefly for post-trade troubleshooting, then hard deleted from memory and Redis to eliminate privacy exposure. |
| **Dispute Evidence Uploads** *(High Sensitivity)* | Binary image data (receipts, photo proofs), original file names, uploader wallet address, MIME metadata | **90 days** after trade finalization / dispute resolution | **Automated Hard Delete** | Contains unencrypted user-uploaded evidence (bank slips, photos). Retained during dispute review and a 90-day appeal/audit window before automated permanent deletion from database and memory. |

---

## 3. Detailed Category Retention Guidelines

### 3.1 Trade Records (Persistent Trade Storage)

- **Storage Location:** `store.ts` (`Map<string, CashRequestRecord>`) and PostgreSQL `cash_requests` & `providers` tables.
- **Fields Stored:** Trade ID, Soroban contract ID, buyer/seller Stellar wallet addresses, amount in stroops, secret hash, secret hex (transient), status (`locked`, `released`, `refunded`, `disputed`, `expired`, `pending_batch`), timeout ledger, notification contact details (email/SMS if opted in), IP address, device ID.
- **Retention Period:** Persistent.
- **End-of-Life Action:** No automated deletion of trade records. Secret hex (`secretHex`) is cleared upon escrow settlement/release.
- **Rationale:** 
  - Trade records provide an immutable record of financial transactions on the Velo platform.
  - Required for calculating user/provider trust tiers and soulbound badge eligibility (`reputation_scores` and `reputation_events`).
  - Preserved for compliance, auditability, and resolving historical transaction inquiries.
  - On-chain Stellar transaction hashes and Soroban escrow contracts are public by nature; maintaining corresponding off-chain trade IDs ensures consistent audit trails.

### 3.2 Chat History (Trade Chat Transport)

- **Storage Location:** `chat-store.ts`, `key-store.ts`, `chat-infrastructure.ts` (`MemoryChatInfrastructure` and `RedisChatInfrastructure` key prefixes `velo:chat:*`).
- **Fields Stored:** Sender wallet address, ciphertext, nonce, creation timestamp, participant X25519 public keys (`publicKey`).
- **Retention Period:** 30 days after trade reaches a terminal status (`released` or `refunded`).
- **End-of-Life Action:** **Automated Hard Delete** via the data retention background worker (`runRetentionPurgeTick`).
- **Rationale:** 
  - Chat history enables buyers and cash providers to coordinate physical meeting locations and timing.
  - Even though messages are end-to-end encrypted (E2E), retaining ciphertext long-term creates unnecessary cryptographic residue and privacy risk if keys are ever compromised.
  - 30 days provides ample time for users to review trade chat context if a post-settlement issue arises.

### 3.3 Dispute Evidence Uploads

- **Storage Location:** `dispute-evidence-store.ts` (`evidenceStore` map) and PostgreSQL `dispute_evidence` table.
- **Fields Stored:** Binary file payload (`data` BYTEA up to 5 MiB), uploader Stellar address, original file name, MIME content-type (`image/jpeg`, `image/png`, `image/webp`), byte size, upload timestamp.
- **Retention Period:** 90 days after trade reaches a terminal status (`released` or `refunded`).
- **End-of-Life Action:** **Automated Hard Delete** via the data retention background worker (`runRetentionPurgeTick`).
- **Rationale:** 
  - Evidence files are uploaded by trade counterparties during active disputes and reviewed by operators (`/admin/trades/:id/evidence`).
  - Uploaded images may contain highly sensitive personal information, such as bank transfer receipts, physical cash photos, or communication screenshots.
  - A 90-day retention window balances operator review needs, potential dispute re-evaluations, and platform audit requirements against user privacy.
  - Once 90 days elapse post-finalization, evidence files are purged permanently from both memory and SQL persistence.

---

## 4. Automated Deletion Mechanism

The Velo API (`apps/api`) runs an automated background worker (`data-retention.ts`) that periodically executes data purge ticks.

### 4.1 Purge Algorithm
1. Scans all trades that are in a terminal state (`released` or `refunded`).
2. **Chat Purge:** For terminal trades where settlement occurred over 30 days ago (configurable via `CHAT_RETENTION_MS`), deletes all associated chat messages and public keys from both memory stores and Redis.
3. **Dispute Evidence Purge:** For terminal trades where settlement occurred over 90 days ago (configurable via `DISPUTE_EVIDENCE_RETENTION_MS`), deletes all associated evidence records and binary blobs from both in-memory stores and PostgreSQL.
4. **Data Integrity:** Trade status, transaction hashes, and account reputation events remain intact. Trade records are never orphaned, and foreign key constraints on `cash_requests` are respected.

### 4.2 Audit Logging
When records are purged, the system emits a structured audit log stating **how many records** were deleted for a trade without recording any deleted message text, nonces, or file content:

```text
[data-retention] Purged chat history (3 messages) and dispute evidence (1 files) for trade 4a8e... (reason: retention_expired)
```

### 4.3 Environment Configuration

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `DATA_RETENTION_POLL_INTERVAL_MS` | `3600000` (1 hour) | Frequency of retention worker purge execution |
| `CHAT_RETENTION_MS` | `2592000000` (30 days) | Retention window for trade chat messages and keys |
| `DISPUTE_EVIDENCE_RETENTION_MS` | `7776000000` (90 days) | Retention window for dispute evidence image uploads |
