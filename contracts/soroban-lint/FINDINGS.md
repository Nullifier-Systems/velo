# Soroban Static Analysis Findings

This document summarizes the findings of `soroban-lint`, a Soroban-specific static
analysis tool that detects contract bugs which generic Rust linting (clippy) cannot
catch because they're specific to Soroban's execution model.

## Methodology

The analyzer walks the AST of Soroban smart contracts using the `syn` crate,
checking for three distinct classes of Soroban-specific issues:

| # | Check | Soroban-Specific Concern |
|---|-------|--------------------------|
| 1 | Missing `require_auth()` | Authorization bypass — functions accepting `Address` params without verifying the caller's identity |
| 2 | Missing `extend_ttl()` | Storage expiration — persistent storage entries without TTL extension may expire before use |
| 3 | CEI pattern violations | State updates after external token transfers, risking incomplete state on failure |

## Findings

### Escrow Contract (`contracts/escrow/src/lib.rs`)

**4 warnings found.** These are informational — the tool reports them for human review.

| # | Check | Function | Severity | Description |
|---|-------|----------|----------|-------------|
| 1 | require_auth | `set_fee_recipient` | Low (false positive) | `recipient` Address param lacks `require_auth()` — but auth is handled by `require_multisig()` instead. Intentional design. |
| 2 | storage_ttl | `dispute` | Medium | Writes to persistent storage without `extend_ttl()` — trade state may expire before resolution |
| 3 | storage_ttl | `resolve` | Medium | Same as `dispute` — persistent write without TTL extension |
| 4 | cei_pattern | `resolve` | Medium | Token transfers occur before the final `env.storage().persistent().set(&key, &state)` — CEI pattern recommends state updates first |

### Atomic-Swap Contract (`contracts/atomic-swap/src/lib.rs`)

**No issues found.** All public functions correctly handle auth, TTL, and CEI.

### HTLC Core (`contracts/htlc-core/src/lib.rs`)

**No issues found.** This crate defines shared types and a trait only.

## Pre-existing Bugs Fixed

During analysis, the following pre-existing compilation errors in the escrow contract
were discovered and fixed:

| Bug | Fix |
|-----|-----|
| Duplicate `get_trade` method defined twice in `impl EscrowContract` | Removed duplicate (kept the first definition) |
| Error enum discriminant collisions (`InvalidFee=10, Unauthorized=10`, `NotAuthorized=11, TimeoutReached=11`, `ContractPaused=12, TradeNotDisputed=12`) | Renumbered to unique values: `Unauthorized=15`, `NotAuthorized=16`, `ContractPaused=17` |
| Missing closing `}` on `resolve()` function | Added the missing brace |

## Summary

| Contract | Analyzed | Warnings | Pre-existing Bugs Fixed |
|----------|---------|----------|------------------------|
| Escrow | ✅ | 4 | 3 |
| Atomic-Swap | ✅ | 0 | 0 |
| HTLC Core | ✅ | 0 | 0 |

## Running the Analyzer

```bash
cd contracts
cargo run -p soroban-lint -- escrow/src/lib.rs atomic-swap/src/lib.rs htlc-core/src/lib.rs
```
