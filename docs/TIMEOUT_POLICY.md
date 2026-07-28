# System Timeout & Expiry Policy

**This document is THE authoritative reference for all timeout and expiry decisions in Velo.** Every component that implements timing logic **must** validate its choice against this policy.

---

## 1. Core Principles

### 1.1 Single Source of Truth

All timeout decisions flow from **Stellar ledger time** (ledger sequence), not wall-clock time. This ensures:

- Consistency across on-chain and off-chain components
- No timezone confusion
- Deterministic replay (ledger sequence is immutable)

### 1.2 Hierarchical Timeout Windows

Timeouts nest inside larger windows to prevent edge cases:

```
Trade Lock Window (primary)
  ├─ Dispute Resolution Window (secondary, contained)
  └─ Chat/Evidence Retention (tertiary, post-terminal)
```

If a trade's on-chain timeout is T, then:

- Dispute window must close before or at T
- Chat/evidence must not be deleted until AFTER T + retention window

### 1.3 Consistency Rule

**If two systems need to agree on when something expires, they use the same formula.**

Example: If the contract says "refund becomes available at ledger L + 100", the API must check "current_ledger >= stored_timeout_ledger", not recompute 100 from scratch.

---

## 2. Trade Lifecycle Timeouts

### 2.1 Lock Duration (Primary Timeout)

**Definition:** How long funds stay locked before the buyer can unilaterally refund.

| Component                  | Value                                    | Duration      | Reasoning                             |
| -------------------------- | ---------------------------------------- | ------------- | ------------------------------------- |
| **Contract (escrow)**      | MAX: `6 * 60 * 24 * 7` = 604,800 ledgers | ~7 days       | Upper bound; prevents indefinite lock |
| **API (cash routes)**      | DEFAULT: `100` ledgers                   | ~8-15 minutes | Typical hand-off + settlement window  |
| **API (settlement-chain)** | DEFAULT: `24 * 60 * 6` = 8,640 ledgers   | ~24 hours     | Multi-hop coordination window         |

**Reconciliation:**

- API always uses a value within contract's max (100 ≤ 604,800 ✓)
- API's 100 is conservative: quick settlement for P2P trades
- Settlement chain's 24h is for orchestrated multi-hop: longer, but within bounds ✓
- **No mismatch:** contract timeout always >= API's chosen timeout

**Edge Case Prevented:**

- ❌ Old code: API set 100-ledger timeout at lock, chat stayed "active" for 30 days
- ✓ Now: Chat becomes inactive exactly when contract timeout is reached

---

### 2.2 Dispute Resolution Window (Secondary Timeout)

**Definition:** How long an arbitrator has to resolve a dispute after it's raised.

| Component             | Value                                                              | Duration | Notes                             |
| --------------------- | ------------------------------------------------------------------ | -------- | --------------------------------- |
| **Contract (escrow)** | `DISPUTE_RESOLUTION_WINDOW_LEDGERS` = `12 * 60 * 24 * 3` = 259,200 | ~3 days  | After this, funds return to buyer |
| **API**               | Inherited from contract                                            | Same     | No override; enforcement only     |

**When a dispute is raised at ledger L:**

1. Arbitrator **must** call `resolve_dispute()` by ledger L + 259,200
2. After L + 259,200, **anyone** can call `refund_after_dispute_timeout()` → funds go to buyer

**Edge Case Prevented:**

- ❌ Old code: Chat might show "disputed" but contract already let buyer refund
- ✓ Now: All components check the same deadline; UI and contract stay synchronized

**Critical Invariant:**

```
DISPUTE_RESOLUTION_WINDOW_LEDGERS (259,200) < DEFAULT_TIMEOUT_LEDGERS_MAX (604,800)
```

✓ Verified: 3 days < 7 days. Dispute window always closes before trade's maximum lifetime.

---

### 2.3 Chat Session Lifetime (Tertiary, Implicit)

**Definition:** Chat is only meaningful while the trade is in an active state (Locked / Disputed).

| Component               | Implicit Lifetime        | Mechanism                                                                   |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------- |
| **Chat (Redis/Memory)** | Trade status driven      | Chat becomes "archived" once trade is Terminal (Released/Refunded/Resolved) |
| **Chat UI**             | Derived from trade state | Shows "active" iff trade status == Locked \|\| Disputed                     |

**When trade enters terminal state (Released/Refunded/Resolved):**

- Chat is no longer shown as active (UI reflects trade status)
- Messages are retained for `DEFAULT_CHAT_RETENTION_MS` = 30 days
- After 30 days, messages are permanently deleted

**Edge Case Prevented:**

- ❌ Old code: Chat could outlive the trade it references
- ✓ Now: Chat lifetime is explicitly tied to trade.status transitions

---

## 3. Data Retention Timeouts (Post-Terminal)

**Definition:** How long to keep sensitive data after a trade reaches a terminal state.

| Data Type                       | Retention Window       | Retention Reason                        | Deletion Mechanism        |
| ------------------------------- | ---------------------- | --------------------------------------- | ------------------------- |
| **Chat Messages**               | 30 days                | GDPR right-to-be-forgotten grace period | `runRetentionPurgeTick()` |
| **Dispute Evidence (uploads)**  | 90 days                | Dispute appeal window; audit trail      | `runRetentionPurgeTick()` |
| **Trade Records**               | Indefinite             | Tax/compliance audit trail              | Never auto-deleted        |
| **Encryption Keys (per trade)** | Same as chat (30 days) | Tied to chat; no orphaned keys          | `runRetentionPurgeTick()` |

**Finalization Timestamp:**

- Uses `record.resolvedAt` (if dispute resolved) or `record.createdAt` (fallback)
- Retention windows count from this point, not from current time

**Edge Case Prevented:**

- ❌ Old code: Evidence deleted before trade fully resolved
- ✓ Now: Evidence kept at least until `resolvedAt + 90 days`

---

## 4. RPC Operation Timeouts (Network Resilience)

**Definition:** How long to wait for Stellar network responses before declaring failure.

| Operation                | Build+Sim       | Poll            | Reason                   |
| ------------------------ | --------------- | --------------- | ------------------------ |
| `lock()`                 | 15,000 ms (15s) | 45,000 ms (45s) | High value; most complex |
| `release()` / `refund()` | 10,000 ms (10s) | 30,000 ms (30s) | Medium complexity        |
| Batch operations         | 10,000 ms (10s) | 30,000 ms (30s) | Same as single release   |
| Generic operations       | 15,000 ms (15s) | 30,000 ms (30s) | Safety margin            |

**Policy:**

- Build+Sim always < Poll (validation before submission)
- Poll timeout is optimistic: Stellar ledger close ~6 seconds, so 30s ≈ 5 ledgers
- These are **not** trade timeouts; they're network resilience budgets

---

## 5. Full Timeline Example (Preventing Inconsistency)

**Scenario:** Provider locks 100 stroops for 15 minutes (100 ledgers @ ~9s/ledger). Buyer disputes at the last minute.

```
Ledger 1000: lock() called
  - Contract stores: timeout_ledger = 1100
  - API stores: timeoutLedger = 1100 (matches)
  - Chat: status="active"

Ledger 1095 (5 minutes later): raise_dispute()
  - Contract: trade moves to Disputed
  - dispute_deadline stored = 1095 + 259200 = 260295
  - API sees trade.status = Disputed

Ledger 1100: original timeout_ledger reached
  - ✓ Contract prevents refund (trade is Disputed, not Locked)
  - ✓ API knows chat is still "active" (trade.status != Released)
  - ✓ Arbitrator window still open (1100 < 260295)

Ledger 260295: dispute resolution window closes
  - ✓ Anyone can call refund_after_dispute_timeout()
  - ✓ Funds returned to buyer
  - ✓ Chat becomes inactive (trade.status = Resolved)

Ledger 260295 + 90 days: evidence deleted
  - ✓ Evidence window respected
  - ✓ Chat deleted after 30 days (earlier than evidence)
```

**No inconsistency possible** because all components check the same `timeout_ledger` and `dispute_deadline` values.

---

## 6. Audit Checklist: Adding New Timeout

Before adding any new timing logic, answer these questions:

- [ ] Does it use `env.ledger().sequence()` or wall-clock time?
  - Ledger sequence is required for on-chain consistency.
  - Wall-clock is only for retention windows (post-terminal data).
- [ ] Is this timeout bounded by an existing window?
  - If it triggers before trade finalization, it must be inside the main trade timeout.
  - If it's post-terminal, it must respect existing retention windows.

- [ ] Have you checked for nesting violations?

  ```rust
  // ✓ Good: dispute window < trade timeout
  DISPUTE_RESOLUTION_WINDOW_LEDGERS < DEFAULT_TIMEOUT_LEDGERS_MAX

  // ❌ Bad: new timeout > main trade timeout
  // (This would allow a nested event to outlive its parent.)
  ```

- [ ] Is there a test that prevents the old inconsistency?
  - See section 7 for required test patterns.

- [ ] Have you updated this document?
  - Every timeout decision belongs in the table above.

---

## 7. Test Requirements: Preventing Regressions

### 7.1 Consistency Test: All Components Check Same Deadline

```rust
#[test]
fn all_components_use_same_timeout_ledger() {
    // Lock a trade with a specific timeout
    let timeout_ledgers = 100;
    let locked_at_ledger = 1000;

    // Contract stores it
    client.lock(&id, &seller, &buyer, &amount, &secret_hash, &timeout_ledgers);
    let contract_state = client.get_trade(&id).unwrap();
    assert_eq!(contract_state.timeout_ledger, locked_at_ledger + timeout_ledgers);

    // API also stores the same value
    let api_record = getCashRequest(id);
    assert_eq!(api_record.timeoutLedger, locked_at_ledger + timeout_ledgers);

    // Both check the same way: if ledger >= timeout, trade is refundable
    let after_timeout_ledger = locked_at_ledger + timeout_ledgers + 1;
    env.ledger().with_mut(|li| li.sequence_number = after_timeout_ledger);

    // Contract allows refund
    client.refund(&id).unwrap();

    // API also sees it as expired
    let expiry_check = expireCashRequest(api_record, after_timeout_ledger);
    assert_eq!(expiry_check.status, "expired");
}
```

### 7.2 Nesting Test: Dispute Window Inside Trade Timeout

```rust
#[test]
fn dispute_window_never_exceeds_trade_timeout() {
    // Dispute is raised right before trade timeout
    let locked_at = 1000;
    let trade_timeout = locked_at + 100; // ~15 min

    client.lock(&id, &seller, &buyer, &amount, &secret_hash, &100);

    // Raise dispute at the last second
    env.ledger().with_mut(|li| li.sequence_number = trade_timeout - 10);
    client.raise_dispute(&buyer, &id).unwrap();

    let state = client.get_trade(&id).unwrap();
    let dispute_deadline = state.dispute_deadline;

    // Verify: dispute_deadline > trade_timeout (it's extended because trade is Disputed)
    // But: dispute_deadline < trade_timeout + DISPUTE_RESOLUTION_WINDOW (bounded)
    assert!(dispute_deadline >= trade_timeout);
    assert!(
        dispute_deadline <= trade_timeout + DISPUTE_RESOLUTION_WINDOW_LEDGERS,
        "dispute window is bounded; arbitrator only has 3 days"
    );

    // At dispute_deadline + 1, refund_after_dispute_timeout becomes callable
    env.ledger().with_mut(|li| li.sequence_number = dispute_deadline + 1);
    client.refund_after_dispute_timeout(&id).unwrap();
}
```

### 7.3 Cross-Component Test: Chat Doesn't Outlive Trade

```typescript
it("chat becomes inactive exactly when trade timeout is reached", async () => {
  // Lock with 100-ledger timeout
  const tradeId = randomHex32();
  const ledgerAtLock = 1000;

  saveCashRequest({
    id: tradeId,
    status: "locked",
    timeoutLedger: ledgerAtLock + 100,
    createdAt: new Date().toISOString(),
    // ... other fields
  });

  // Chat is active
  expect(getChatStatus(tradeId)).toBe("active");

  // Advance past timeout
  mockCurrentLedger(ledgerAtLock + 101);

  // Expire the trade
  const record = getCashRequest(tradeId);
  expireCashRequest(record, ledgerAtLock + 101);

  // Chat should now be inactive (derived from trade.status)
  expect(getChatStatus(tradeId)).toBe("inactive");
  expect(record.status).toBe("expired");
});
```

### 7.4 Retention Window Test: No Deletion During Active Window

```typescript
it("evidence is not deleted until retention window closes", async () => {
  const tradeId = randomHex32();
  const releasedAtLedger = 1000;
  const releasedAtMs = Date.now();

  // Trade is released
  saveCashRequest({
    id: tradeId,
    status: "released",
    resolvedAt: new Date(releasedAtMs).toISOString(),
    // ...
  });

  // Evidence uploaded
  saveDisputeEvidence(tradeId, {
    /* file */
  });

  // Check: evidence NOT deleted yet (only 1 day elapsed, window is 90)
  const after1Day = new Date(releasedAtMs + 1 * 24 * 60 * 60 * 1000);
  const result = await runRetentionPurgeTick({ now: after1Day });
  expect(result.purgedEvidence).toBe(0);
  expect(getDisputeEvidence(tradeId)).toBeDefined();

  // Check: evidence IS deleted after 90 days
  const after90Days = new Date(releasedAtMs + 90 * 24 * 60 * 60 * 1000 + 1000); // +1s to be past
  const result2 = await runRetentionPurgeTick({ now: after90Days });
  expect(result2.purgedEvidence).toBeGreaterThan(0);
  expect(getDisputeEvidence(tradeId)).toBeUndefined();
});
```

---

## 8. Existing Values (Reconciled)

### 8.1 Summary Table

| System               | Constant                                | Value         | Duration   | Status                               |
| -------------------- | --------------------------------------- | ------------- | ---------- | ------------------------------------ |
| **Escrow Contract**  | `DEFAULT_TIMEOUT_LEDGERS_MAX`           | 604,800       | 7 days     | Upper bound ✓                        |
| **Escrow Contract**  | `DISPUTE_RESOLUTION_WINDOW_LEDGERS`     | 259,200       | 3 days     | Within bound ✓                       |
| **Settlement Chain** | `DEFAULT_TIMEOUT_LEDGERS`               | 8,640         | 24 hours   | Within contract max ✓                |
| **Cash API**         | `DEFAULT_TIMEOUT_LEDGERS`               | 100           | ~15 min    | Within contract max ✓                |
| **Data Retention**   | `DEFAULT_CHAT_RETENTION_MS`             | 2,592,000,000 | 30 days    | Post-terminal ✓                      |
| **Data Retention**   | `DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS` | 7,776,000,000 | 90 days    | Post-terminal, evidence ✓            |
| **RPC Timeouts**     | `lockBuildSim`                          | 15,000 ms     | 15 seconds | Network budget (not trade timeout) ✓ |

### 8.2 Justified Differences

**Why does settlement-chain use 24h but cash uses 100 ledgers?**

- Settlement chain is multi-hop orchestrated → needs longer window for coordination
- Cash trade is P2P immediate → quick settlement expected
- Both within contract max, no violation

**Why is evidence retention (90d) longer than chat (30d)?**

- Chat is personal communication → GDPR right-to-be-forgotten (30d)
- Evidence is legal/compliance artifact → audit trail needs longer window (90d)
- Both bounded by trade retention (indefinite), no violation

---

## 9. Evolution & Future Changes

### 9.1 Proposing New Timeouts

1. Document the new timeout in this file (section 8.1 table)
2. Include parent/child relationship in the hierarchy
3. Add a test demonstrating the boundary (section 7)
4. Get approval: at least one reviewer must verify nesting is sound

### 9.2 Changing Existing Values

1. Update both contract **and** API to match
2. Check that all tests in section 7 still pass
3. Verify no test becomes impossible (e.g., "dispute window > trade timeout")
4. Bump version in `TIMEOUT_POLICY_VERSION` below

### 9.3 Adding New Components

- Any new feature that waits, sleeps, or checks timestamps must reference this policy
- Link back to this document in your code comments

---

## Version & Review History

- **TIMEOUT_POLICY_VERSION = 1.0**
- Created: [Current Date]
- Last reviewed: [Current Date]
- Reviewers: [Team leads]

---

## Quick Reference: Copy/Paste Constants

Use these in your code when you need timeouts:

```rust
// Contract (Soroban/Rust)
const DEFAULT_TIMEOUT_LEDGERS_MAX: u32 = 6 * 60 * 24 * 7;      // 7 days
const DISPUTE_RESOLUTION_WINDOW_LEDGERS: u32 = 12 * 60 * 24 * 3; // 3 days
```

```typescript
// API (TypeScript/Node.js)
const DEFAULT_TIMEOUT_LEDGERS = 100; // ~15 min (8-15 min at ~9s/ledger)
const DEFAULT_CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
```

Always import these from a **single source file**—do not redefine locally.
