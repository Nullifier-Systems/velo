# Escrow SEP-41 Reentrancy & Composability Audit (Issue #273)

## Goal

Determine whether a malicious SEP-41 token implementation can corrupt escrow state
or cause double-payouts via callback / reentrant calls during
`token::Client::transfer()`, and harden any real gaps.

Out of scope: auditing the production SAC / USDC token implementations themselves.
Focus is escrow robustness against a hypothetical adversarial token.

## Soroban execution model (relevant facts)

1. **Synchronous cross-contract calls.** When escrow invokes `transfer` on a
   token contract, that call runs to completion (or traps) before escrow resumes.
2. **No classical reentrancy.** The Soroban host rejects re-entry into a contract
   that already has a frame on the call stack. Debug message:
   `"Contract re-entry is not allowed"`. Empirically confirmed with the
   malicious test token in this repo (see `contracts/escrow/src/reentrancy_test.rs`).
3. **Invocation atomicity.** Storage writes and token movements inside one top-level
   invocation commit together or not at all. A trap during `transfer` rolls back
   any status flip that happened earlier in the same call.
4. **Authorization is explicit.** Nested calls still need matching
   `SorobanAuthorizationEntry` trees. A token cannot silently “borrow” the
   buyer’s auth for arbitrary escrow entry points unless the transaction signed
   that path.
5. **Self-reentrancy** (contract calling itself) is a narrower host case and is
   not how SEP-41 `transfer` callbacks work. Escrow does not call itself.

### What this means for “reentrancy”

Ethereum-style DAO reentrancy (drain via recursive withdraw before balance update)
is **not** available against escrow through a token callback: the host blocks the
re-entry before escrow’s second entry point runs.

Residual / adjacent risks that **do** still matter:

| Risk | Why it still matters | Escrow posture |
|------|----------------------|----------------|
| CEI ordering | Defense-in-depth if host policy changes; clearer failure modes; static analyzers flag it | Outflows already CEI; inflows hardened in this change |
| Malicious token semantics | Token may not move funds, move wrong amounts, or always trap | Admin chooses token at `initialize`; not a runtime user choice |
| DoS via always-trapping token | Every transfer path fails | Operational / admin trust in token address |
| Auth confusion | Token tries nested escrow calls with incomplete auth | Host / auth tree rejects; covered by adversarial tests |

## Transfer call-site inventory

| Site | Direction | Pre-fix status check | State written before transfer? | Notes |
|------|-----------|------------------------|--------------------------------|-------|
| `lock` | buyer → escrow (+ optional bond) | `!has(Trade)` | **Yes (fixed)** | Trade + bond bookkeeping committed before pulls |
| `commit_escrow` | buyer → escrow (collateral) | `!has(Commitment)` | **Yes (fixed)** | Commitment recorded before collateral pull |
| `reveal_escrow` | buyer → escrow (amount); escrow → buyer (collateral refund) | commitment window checks | **Yes (fixed)** | Trade locked + commitment removed before transfers |
| `stake_arbitrator` | arbitrator → escrow | auth | **Yes (fixed)** | Stake balance updated before pull |
| `release` | escrow → seller (+ fee) | `Locked` | Yes | Status → `Released` first |
| `refund` | escrow → buyer | `Locked` + timeout | Yes | Status → `Refunded` first |
| `batch_release` / `release_batch` | escrow → seller (+ fee) | `Locked` per item | Yes | Per-item CEI |
| `resolve_dispute` | split payouts | `Disputed` | Yes | Status → `Resolved` first |
| `fallback_after_timeout` | escrow → buyer | `Disputed` + window | Yes | Status → `Refunded` first |
| `complete_with_bond_refund` (helper) | escrow → buyer | bond present | **Yes (fixed)** | Bond key removed before refund transfer |

Invariant for fund **exits**: a trade must be in the expected status; that status
is flipped **before** any outbound `transfer`. A second exit path in the same
invocation cannot succeed even if re-entry were allowed, because storage already
shows a terminal / non-matching status.

## Adversarial test token

`contracts/escrow/src/malicious_token.rs` implements a minimal SEP-41-shaped
token (`transfer`, `balance`, `mint`) that, on configured transfers, attempts to
re-enter escrow (`release`, `refund`, `lock`, `resolve_dispute`, etc.).

Tests assert:

1. The reentrant call is rejected by the host (outer call fails).
2. Trade status and balances are unchanged after the failed attempt (no
   corruption, no double-payout).
3. With CEI ordering, even if re-entry were hypothetically allowed, terminal
   status would already be set before the outbound transfer.

## Fixes applied

1. Reordered **inflow** paths (`lock`, `commit_escrow`, `reveal_escrow`,
   `stake_arbitrator`) to write escrow bookkeeping **before** calling
   `transfer` (Checks → Effects → Interactions under Soroban atomicity).
2. Reordered `complete_with_bond_refund` to clear the bond key before refunding.
3. Added the malicious token + reentrancy attempt suite.
4. Updated the in-contract invariant comment to match the real transfer surface.

## Conclusion

Classical callback reentrancy cannot double-pay through this escrow on current
Soroban hosts. The remaining work is composability hygiene: CEI on every
transfer site, admin trust in the configured SEP-41 address, and continuous
adversarial tests so a future host/SDK change cannot silently reintroduce
DAO-style drains.
