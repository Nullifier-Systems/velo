# Velo Contracts

Soroban smart contracts for the Velo protocol: escrow, atomic swap, HTLC core, reputation, settlement, and tooling.

## Workspace Structure

```
contracts/
  Cargo.toml              # Workspace root
  htlc-core/              # Shared HTLC types and trait
  escrow/                 # P2P cash escrow contract
    src/lib.rs            # Contract implementation
    src/test.rs           # Unit tests
    src/property_test.rs  # Proptest property tests
    src/mev_protection_test.rs
    fuzz/                 # Fuzzing & property-testing harness
      Cargo.toml
      src/
        lib.rs
        reference_machine.rs   # Pure-Rust state machine reference
        invariants.rs          # Invariant checkers
        state_generator.rs     # Proptest operation generators
        differential.rs        # Differential fuzzing engine
        bin/
          differential_fuzz.rs
          arithmetic_overflow_fuzz.rs
          state_transition_fuzz.rs
          invariant_fuzz.rs
  atomic-swap/
  reputation/
  settlement-chain/
  zk-credential/
  soroban-lint/
```

## Running Property Tests (Soroban Contract)

Property tests are embedded in the escrow crate and use `proptest` against
the on-chain contract via Soroban's test SDK.

```bash
cd contracts
cargo test -p escrow -- --ignored
```

This runs:
- **`randomized_actions_preserve_accounting_and_transition_graph`** — random lock/release/refund/dispute sequences
- **`refunds_before_timeout_never_succeed`** — timelock enforcement
- **`solvency_invariant_holds_under_random_operations`** — contract balance >= active escrow amounts
- **`no_locked_funds_invariant`** — every trade has a reachable terminal state
- **`monotonic_timelock_invariant`** — hashlock constraints are immutable across ledger advances
- **`cross_trade_independence`** — operations on one trade never affect another
- **`batch_release_matches_individual_accounting`** — batch release produces identical accounting

## Running Fuzz Targets

The fuzz harness lives in `contracts/escrow/fuzz/` and is part of the
workspace. Each binary exercises a different dimension of contract safety.

### Differential Fuzzing

Compares the pure-Rust reference state machine against itself under
randomized operation sequences. Verifies determinism, conservation of value,
and all invariants after every step.

```bash
cd contracts/escrow/fuzz
cargo run --release --bin differential_fuzz -- [ITERATIONS] [MAX_TRADES]

# Example: 10,000 iterations with up to 8 concurrent trades
cargo run --release --bin differential_fuzz -- 10000 8
```

### Arithmetic Overflow Fuzzing

Tests fee calculation, dispute split arithmetic, and boundary values for
overflow, underflow, and rounding errors.

```bash
cargo run --release --bin arithmetic_overflow_fuzz -- [ITERATIONS]

# Example: 50,000 iterations
cargo run --release --bin arithmetic_overflow_fuzz -- 50000
```

### State Transition Fuzzing

Generates arbitrary sequences of lock, release, refund, dispute, resolve,
and ledger-advance operations. Validates that:
- Every step maintains all invariants (solvency, conservation, no locked funds)
- State transitions follow the valid state graph (Locked -> Released/Refunded/Disputed, etc.)
- No double-spend or conservation violation is possible

```bash
cargo run --release --bin state_transition_fuzz -- [ITERATIONS] [MAX_TRADES]

# Example: 100,000 iterations
cargo run --release --bin state_transition_fuzz -- 100000 8
```

### Invariant Fuzzing

Comprehensive invariant checking across 5 phases:
1. Full state machine invariant checks (invariants verified after every step)
2. Solvency invariant (contract balance >= sum of active escrow amounts)
3. No-locked-funds invariant (every trade has a reachable terminal state)
4. Monotonic timelock invariant (hashlock constraints never corrupted by ledger advancement)
5. Differential invariant verification (proptest-driven loop)

```bash
cargo run --release --bin invariant_fuzz -- [ITERATIONS] [MAX_TRADES]

# Example: 100,000 iterations
cargo run --release --bin invariant_fuzz -- 100000 8
```

### Running All Fuzz Targets

```bash
cd contracts/escrow/fuzz

# Quick sanity check (500 iterations each)
cargo run --release --bin differential_fuzz -- 500 6
cargo run --release --bin arithmetic_overflow_fuzz -- 500
cargo run --release --bin state_transition_fuzz -- 500 6
cargo run --release --bin invariant_fuzz -- 500 6

# Full 10M+ run (all four targets)
cargo run --release --bin differential_fuzz -- 10000000 8
cargo run --release --bin arithmetic_overflow_fuzz -- 10000000
cargo run --release --bin state_transition_fuzz -- 10000000 8
cargo run --release --bin invariant_fuzz -- 10000000 8
```

## Property Invariants Enforced

### Solvency Invariant

```
contract_balance >= sum(active_escrow_amounts)
```

The contract's token balance must always be at least the sum of all
Locked and Disputed trade amounts. This guarantees the contract can
fulfill all outstanding obligations.

### No Locked Funds Invariant

For every trade in state `S`, there exists a sequence of valid operations
that transitions `S` to a terminal state (Released, Refunded, or Resolved):

- **Locked**: release (with correct secret) or refund (after timeout)
- **Disputed**: resolve_dispute (by arbitrator) or refund_after_dispute_timeout
- **Released/Refunded/Resolved**: already terminal

### Monotonic Timelock Invariant

Advancing the block ledger sequence never corrupts existing hashlock
constraints. The `secret_hash` and `timeout_ledger` of a trade are
immutable once locked. Ledger advancement can only:
- Enable refund (after timeout) for Locked trades
- Enable refund_after_dispute_timeout for Disputed trades
- Leave the trade unchanged

### Conservation of Value

```
buyer_balance + seller_balance + admin_balance + contract_balance == initial_supply
```

Tokens are neither created nor destroyed by contract operations.

### Fee Arithmetic Correctness

For any amount `A` and fee basis points `F` (0 <= F <= 10,000):
- `fee = (A * F) / 10_000`
- `payout = A - fee`
- `fee + payout == A`
- `fee * 10_000 <= A * F` (truncation rounds down, favoring the seller)

### Dispute Split Correctness

For any amount `A`, buyer share `B` (basis points), and fee `F`:
- `buyer_amount = (A * B) / 10_000`
- `seller_gross = A - buyer_amount`
- `fee = (seller_gross * F) / 10_000`
- `seller_payout = seller_gross - fee`
- `buyer_amount + seller_payout + fee == A`

## Reference State Machine

The fuzz harness includes a pure-Rust reference state machine
(`fuzz/src/reference_machine.rs`) that mirrors the Soroban escrow contract's
logic without any Soroban dependency. This enables:

1. **Differential testing**: Execute the same operation sequence on two
   independent instances and verify identical results
2. **Invariant checking**: Verify mathematical properties of the state
   machine without needing the full Soroban runtime
3. **High-throughput fuzzing**: Pure-Rust execution is orders of magnitude
   faster than WASM-based contract testing

The reference machine implements all contract operations:
- `lock()` — escrow funds against a secret hash and timeout
- `release()` — pay seller by revealing secret
- `refund()` — return funds to buyer after timeout
- `raise_dispute()` — flag trade for arbitration
- `resolve_dispute()` — split funds between buyer and seller
- `refund_after_dispute_timeout()` — permissionless refund after arbitrator window expires

## CI Integration

For continuous fuzzing in CI, run each target with sufficient iterations
and fail on any invariant violation:

```yaml
# Example GitHub Actions step
- name: Run fuzz targets
  run: |
    cd contracts/escrow/fuzz
    cargo run --release --bin differential_fuzz -- 100000 8
    cargo run --release --bin arithmetic_overflow_fuzz -- 100000
    cargo run --release --bin state_transition_fuzz -- 100000 8
    cargo run --release --bin invariant_fuzz -- 100000 8
```

All fuzz binaries exit with code 1 on any invariant violation, making them
suitable for CI pipeline gating.
