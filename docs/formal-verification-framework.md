# Automated Contract Upgrade Formal Invariant Verification Framework

## Overview

This framework automates the verification of Soroban smart contract upgrades against formal invariants established through state-machine and accounting proofs. Rather than requiring manual re-auditing whenever contract code changes, the framework executes a machine-checkable specification against any new version of the contract to verify that critical security and operational invariants remain preserved.

## Architecture

The framework consists of four core components:

1. **Machine-Checkable Specification Format** (`contracts/specifications/*.json`):
   - Structured JSON schema specifying invariant identifiers, mathematical/logical expressions, categories, severity levels, and description text.
2. **Verification Engine (`invariant-verifier` crate)**:
   - Reusable Rust tool (`contracts/invariant-verifier`) that parses invariant specifications and executes dynamic verification suites against contract implementations.
3. **Mutation & Violation Test Suite** (`contracts/invariant-verifier/tests/verification_test.rs`):
   - Automated tests demonstrating framework success on valid contract versions and catching/flagging deliberate invariant violations.
4. **CI Automated Gate** (`.github/workflows/contracts-ci.yml`):
   - Continuous Integration step that blocks pull requests or contract modifications failing invariant verification.

## Formal Invariants Spec (`contracts/specifications/htlc_escrow_invariants.json`)

The initial specification covers six core invariants for HTLC escrow smart contracts:

| Invariant ID | Name | Category | Description |
|--------------|------|----------|-------------|
| `INV-01` | Conservation of Value | Accounting | `balance(buyer) + balance(seller) + balance(admin) + balance(contract) == total_minted_initial`. Held funds strictly equal deposited amounts across state transitions. |
| `INV-02` | State Machine Exclusivity & Monotonicity | State Machine | Terminal states (`Released`, `Refunded`) cannot be mutated or transitioned out of. Valid transitions are strictly `Locked` -> `Disputed` \| `Released` \| `Refunded`, and `Disputed` -> `Released` \| `Refunded`. |
| `INV-03` | Timeout Monotonicity | Temporal | `refund()` fails with `TimeoutNotReached` if `ledger < timeout_ledger`. `dispute()` fails with `TimeoutReached` if `ledger >= timeout_ledger`. |
| `INV-04` | Secret Hash Correctness | Cryptographic | `release()` succeeds if and only if `sha256(secret) == secret_hash`. Incorrect preimages return `InvalidSecret`. |
| `INV-05` | Fee Math Conservation & Bounds | Arithmetic | `platform_fee_bps <= 10000`. `fee = (amount * fee_bps) / 10000` and `fee + payout == amount` with zero balance leakage. |
| `INV-06` | Authorization & Governance Integrity | Access Control | Privileged admin functions (`resolve`, `pause`, `set_platform_fee`) reject unauthorized callers and enforce N-of-M multisig thresholds. |

## Running the Verification Tool

To run the verification framework locally:

```bash
cd contracts
cargo run -p invariant-verifier -- --spec specifications/htlc_escrow_invariants.json
```

### Running Framework Tests

To execute the test suite (verifying both positive contract verification and negative mutation detection):

```bash
cd contracts
cargo test -p invariant-verifier
```

## Adding New Invariants for Contract Upgrades

When upgrading contracts or introducing new features:

1. Open `contracts/specifications/htlc_escrow_invariants.json`.
2. Add a new invariant entry under `invariants`:
   ```json
   {
     "id": "INV-07",
     "name": "New Contract Feature Invariant",
     "category": "Security",
     "description": "Description of invariant condition.",
     "expression": "logical_expression",
     "severity": "HIGH"
   }
   ```
3. Implement the corresponding assertion check method in `contracts/invariant-verifier/src/checker.rs`.
4. Run `cargo test -p invariant-verifier` to confirm verification passes.
