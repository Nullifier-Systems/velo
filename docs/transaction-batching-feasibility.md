# Transaction Batching Feasibility for Provider Payouts

**Issue:** [#205](https://github.com/Nullifier-Systems/velo/issues/205)  
**Status:** Research analysis — **not a binding implementation recommendation**  
**Date:** 2026-07-21  
**Purpose:** Determine whether Stellar/Soroban supports efficient batched multi-recipient payments and quantify fee savings over per-trade payouts.

---

## 1. Scope and assumptions

This analysis covers:

1. **Per-trade payout model:** Each completed trade triggers an individual `release()` call on the escrow contract, paying out the seller (cash provider) and deducting the platform fee in a single Soroban transaction.
2. **Batched payout model:** Multiple completed trades are settled in a single Soroban transaction that transfers funds to multiple recipients atomically.

Key assumptions:

- Velo uses USDC on Stellar (Soroban-managed escrow).
- Provider payouts are the primary volume driver (one payout per completed trade).
- Platform fees are collected per trade.
- The analysis uses Stellar's current fee structure (base fee ~0.00001 XLM per operation, plus Soroban rent and compute fees).

---

## 2. Stellar transaction fee mechanics

### 2.1 Base fees

| Component              | Cost                                     | Notes                                    |
| ---------------------- | ---------------------------------------- | ---------------------------------------- |
| Base fee per operation | ~~0.00001 XLM (~~$0.000001 at $0.10/XLM) | Minimum per `Operation` in a transaction |
| Soroban footprint rent | Variable                                 | Depends on contract storage reads/writes |
| Soroban compute budget | Variable                                 | CPU instructions consumed                |
| Historical fee surge   | 0-100x                                   | During network congestion                |

### 2.2 Transaction structure limits

| Limit                           | Value                  | Impact on batching                                                          |
| ------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| Max operations per transaction  | 100                    | Caps batch size at 100 payouts                                              |
| Max transaction size            | 700 KB                 | Each payment op is ~200 bytes; ~3500 ops theoretical but capped by op limit |
| Max Soroban instructions per tx | ~200M (default budget) | Soroban compute is the real bottleneck                                      |

### 2.3 Soroban contract invocation cost

A single Soroban `invokeContractFunction` costs:

- **Read/write footprint:** proportional to storage accessed
- **CPU instructions:** proportional to contract logic
- **Memory:** proportional to data processed

For a batched payout contract, each additional recipient adds:

- 1 Soroban token `transfer()` call (~10K-50K instructions)
- 1 storage write (trade state update)
- 1 event emission

---

## 3. Batching architecture options

### Option A: Off-chain batching with single on-chain settlement

A batch coordinator accumulates completed trades over a time window (e.g., 5-15 minutes), then submits a single Soroban transaction that:

1. Reads all pending trade states
2. Transfers USDC to each recipient in one multi-operation transaction
3. Transfers platform fees to the fee recipient
4. Updates all trade states to "released"

**Pros:**

- Amortizes base fee across N trades
- Single ledger confirmation for N payouts
- Reduces RPC round-trips

**Cons:**

- Adds latency (providers must wait for batch window)
- Requires batch coordinator infrastructure (new service)
- Complex failure handling (partial batch failures)
- All-or-nothing atomicity may cause delays for individual trades

### Option B: Soroban batch payout contract

A dedicated Soroban contract that accepts an array of `(trade_id, recipient, amount)` tuples and executes all transfers in a single contract invocation.

**Pros:**

- Single Soroban transaction for N payouts
- Atomic — either all succeed or all revert
- Clean, auditable on-chain record

**Cons:**

- Soroban compute budget limits batch size (~50-80 payouts per tx depending on complexity)
- Contract upgrade risk if batch format changes
- Still requires off-chain batch coordination

### Option C: Stellar payment batching (non-Soroban)

Use Stellar's native payment batching (100 operations per transaction) instead of Soroban contract invocations. The batch coordinator builds a transaction with N `Operation.payment()` calls.

**Pros:**

- 100 payments per transaction (Stellar native limit)
- Lowest per-payment cost (no Soroban compute overhead)
- Fastest settlement (classic Stellar tx, no Soroban footprint)

**Cons:**

- Cannot use Soroban escrow state machine (must move funds out of escrow first)
- Loses HTLC guarantees during batch window
- Requires trustline management for USDC

---

## 4. Cost comparison

### Assumptions for calculation

| Parameter                        | Value       |
| -------------------------------- | ----------- |
| Trades per day                   | 1,000       |
| Average batch window             | 10 minutes  |
| Batches per day                  | 144         |
| Trades per batch (avg)           | ~7          |
| Stellar base fee                 | 0.00001 XLM |
| XLM price                        | $0.10       |
| Soroban compute fee per transfer | ~0.0001 XLM |

### Per-trade payout (current model)

| Cost component         | Per trade        | Daily (1,000 trades) |
| ---------------------- | ---------------- | -------------------- |
| Base fee (1 operation) | 0.00001 XLM      | 0.01 XLM             |
| Soroban compute        | ~0.0005 XLM      | 0.5 XLM              |
| **Total per trade**    | **~0.00051 XLM** | **~0.51 XLM**        |
| **USD equivalent**     | **~$0.000051**   | **~$0.051**          |

### Batched payout (Option A/B)

| Cost component                | Per batch (7 trades) | Daily (144 batches) |
| ----------------------------- | -------------------- | ------------------- |
| Base fee (7 operations)       | 0.00007 XLM          | 0.01008 XLM         |
| Soroban compute (7 transfers) | ~0.0035 XLM          | 0.504 XLM           |
| Batch coordinator overhead    | ~0.0001 XLM          | 0.0144 XLM          |
| **Total per batch**           | **~0.00367 XLM**     | **~0.528 XLM**      |
| **USD equivalent**            | **~$0.000367**       | **~$0.0528**        |

### Savings analysis

| Model     | Daily cost (XLM) | Daily cost (USD) | Savings vs per-trade |
| --------- | ---------------- | ---------------- | -------------------- |
| Per-trade | 0.51 XLM         | $0.051           | —                    |
| Batched   | 0.528 XLM        | $0.0528          | **-3.5% (worse)**    |

**Key finding:** At current Stellar fee levels, batching provides **negligible or negative** fee savings because:

1. Stellar base fees are already extremely low (~$0.000001 per operation)
2. Soroban compute costs dominate and scale linearly with batch size
3. The batch coordinator adds overhead that partially offsets base fee savings

### When batching becomes worthwhile

| Scenario                                 | Threshold       | Savings                           |
| ---------------------------------------- | --------------- | --------------------------------- |
| Network congestion (10x fee surge)       | >100 trades/day | ~10-30%                           |
| High-volume providers (1000+ trades/day) | >500 trades/day | ~15-25%                           |
| Soroban compute cost reduction           | Any volume      | Proportional to compute reduction |

---

## 5. Latency and UX tradeoffs

| Factor                  | Per-trade         | Batched                   |
| ----------------------- | ----------------- | ------------------------- |
| Provider receives funds | Immediate (< 30s) | Delayed (5-15 min window) |
| Confirmation UX         | Single tx hash    | Batch tx hash             |
| Failure isolation       | Per-trade         | All-or-nothing            |
| Reversibility           | Individual        | Batch-wide                |

**Recommendation:** For Velo's use case (cash providers need fast, reliable payouts), the latency penalty of batching outweighs the minimal fee savings.

---

## 6. Soroban batch support (current state)

### 6.1 Native Soroban capabilities

Soroban supports:

- **Multi-operation transactions:** Up to 100 operations per Stellar transaction, including multiple contract invocations
- **Atomic execution:** All operations in a transaction succeed or fail together
- **Contract-to-contract calls:** A batch contract can invoke the token contract N times

### 6.2 What Soroban does NOT natively support

- **Batched transfer API:** No built-in `transferBatch()` or `multiTransfer()` function in the Soroban token standard
- **Lazy settlement:** No native mechanism for accumulating pending transfers and settling later
- **Cross-contract batching:** Each contract invocation has independent compute costs; there's no "batch discount"

### 6.3 Implementation path for batching

To implement batching, Velo would need:

1. A new Soroban contract with a `batchRelease(trades: Vec<TradeRelease>)` function
2. An off-chain batch coordinator service that:
   - Polls for completed trades in "pending_release" status
   - Accumulates trades over a configurable window
   - Submits batch transactions
3. Updated escrow contract state machine to support "pending_release" status
4. Error handling for partial batch failures (though Soroban atomicity makes this all-or-nothing)

---

## 7. Recommendations

### 7.1 Short-term (current volume)

**Do not implement batching.** Reasons:

- Fee savings are negligible at current Stellar fee levels
- Added complexity in contract, API, and infrastructure
- Payout latency negatively impacts provider UX
- Current per-trade model is simpler to debug and audit

### 7.2 Medium-term (100-500 trades/day)

**Monitor and prototype.** If Velo reaches meaningful volume:

- Build a batch coordinator as a standalone service
- Implement a `batchRelease()` function in a new Soroban contract
- Run A/B testing: batched vs. per-trade for fee and latency comparison
- Consider batching only for high-volume providers (opt-in)

### 7.3 Long-term (1000+ trades/day)

**Implement batching selectively.** When volume justifies:

- Use Option A (off-chain batching with single on-chain settlement)
- Batch window: 5-10 minutes (balance latency vs. savings)
- Implement fallback: if batch window expires, fall back to per-trade payout
- Monitor Stellar network fee surges and dynamically adjust batch window

---

## 8. Alternative cost optimization strategies

Instead of batching, consider:

1. **Fee-bump optimization:** Use Stellar's fee-bump sponsor pattern to consolidate signing costs (already implemented in Velo's custodial flow)
2. **Batch platform fee collection:** Collect platform fees less frequently (e.g., daily aggregate) to reduce per-trade Soroban invocations
3. **State channel pattern:** Off-chain trade settlement with periodic on-chain reconciliation (complex but maximally efficient)
4. **Stellar smart contract optimization:** Reduce Soroban compute costs by optimizing contract storage layout and instruction count

---

## 9. Sources to re-verify live

- Stellar network base fee: [Stellar Status](https://status.stellar.org/)
- Soroban compute budget limits: [Soroban Documentation](https://soroban.stellar.org/docs)
- Stellar transaction operation limits: [Stellar Developer Docs](https://developers.stellar.org/docs/)
- USDC on Stellar transfer costs: [Circle USDC on Stellar](https://www.circle.com/en/usdc-multichain/stellar)

---

## 10. Bottom line for #205

1. **Batching is technically feasible** on Stellar/Soroban via multi-operation transactions or a dedicated batch payout contract.
2. **Fee savings are negligible** at current Stellar fee levels and typical Velo trade volumes.
3. **Latency penalty is significant** — providers wait 5-15 minutes instead of immediate payout.
4. **Recommendation:** Do not implement batching now; revisit at 500+ trades/day.
5. **Better cost optimization paths** exist: fee-bump optimization, aggregate fee collection, and contract compute optimization.

_Prepared for Velo / Nullifier Systems open research. Not a binding implementation recommendation._
