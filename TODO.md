# TODO

## Escrow #16
- [ ] Inspect escrow CI workaround location (continue-on-error) and remove it
- [ ] Implement real Soroban token test client wiring in `contracts/escrow/src/lib.rs`
- [ ] Add edge-case tests: double-lock, zero/negative amounts, invalid timeouts, unauthorized release
- [ ] Update contract to enforce seller authorization on `release`
- [ ] Run `cargo test --workspace` under `contracts/` and ensure clean pass

