# Multi-Party Atomic Settlement Chains - Implementation TODO

## Steps

- [x] Create implementation plan
- [x] Create `contracts/settlement-chain/Cargo.toml`
- [x] Create `contracts/settlement-chain/src/lib.rs` with:
  - [x] Data structures (ChainHop, ChainState, ChainStatus)
  - [x] Authorization model (create_chain requires all-party consent)
  - [x] `create_chain()` implementation
  - [x] `settle_chain()` implementation with atomic execution
  - [x] `refund_chain()` implementation
  - [x] `get_chain()` read accessor
- [x] Add inline tests:
  - [x] Test 1: 3-party chain A→B→C settled atomically
  - [x] Test 2: Chain with invalid leg reverts fully
  - [x] Test 3: Non-consenting intermediate hop rejected
  - [x] Test 4: Party not in any hop cannot force consent
  - [x] Test 5: settle_chain without sender auth panics
  - [x] Test 6: refund_chain after timeout succeeds
  - [x] Test 7: Chain exceeding MAX_CHAIN_HOPS rejected
  - [x] Test 8: Double settlement is idempotent
- [x] Edit `contracts/Cargo.toml` to add workspace member
- [ ] Run `cargo build` to verify compilation (requires Rust toolchain on this machine)
- [ ] Run `cargo test -p settlement-chain` to verify all tests pass (requires Rust toolchain on this machine)

