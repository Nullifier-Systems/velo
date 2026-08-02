use escrow_fuzz_lib::differential;
use escrow_fuzz_lib::invariants;
use escrow_fuzz_lib::reference_machine::ReferenceState;
use escrow_fuzz_lib::state_generator::{make_secret, make_secret_hash, make_trade_id, EscrowOp};
use std::collections::HashMap;
use std::env;
use std::process;

fn main() {
    let iterations: usize = env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(10_000);

    let max_trades: usize = env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(8);

    eprintln!(
        "Running invariant fuzzer: {} iterations, max {} trades",
        iterations, max_trades
    );

    let mut failures = 0u64;

    // -----------------------------------------------------------------------
    // Phase 1: Full state machine invariant fuzzing
    // -----------------------------------------------------------------------
    eprintln!("  Phase 1: Full state machine invariants...");
    for i in 0..iterations {
        let ops = generate_random_ops(max_trades, i as u64);
        let initial = 1_000_000i128;

        match run_with_invariant_checks(&ops, initial) {
            Ok(_) => {
                if (i + 1) % 1000 == 0 {
                    eprintln!("  [+] {} invariant checks passed", i + 1);
                }
            }
            Err(e) => {
                failures += 1;
                eprintln!("INVARIANT FAILURE at {}: {}", i, e);
                if failures > 10 {
                    eprintln!("Too many failures, aborting.");
                    process::exit(1);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Phase 2: Solvency-specific fuzzing
    // -----------------------------------------------------------------------
    eprintln!("  Phase 2: Solvency invariant...");
    for i in 0..iterations / 10 {
        let initial = ((i as i128) % 1_000_000) + 1;
        let fee_bps = ((i as u32).wrapping_mul(7) % 10_001) as u32;
        let mut state = ReferenceState::new(initial, fee_bps, 1000);
        let mut secrets: HashMap<u8, [u8; 32]> = HashMap::new();

        // Lock multiple trades
        for j in 0..8 {
            let secret = make_secret(j as u8);
            let hash = make_secret_hash(&secret);
            let id = make_trade_id(j);
            let amount = ((i as i128 + j as i128 * 100) % (initial / 10).max(1)) + 1;
            state.lock(id, 1, 2, amount, hash, 100);
            secrets.insert(j, secret);
        }

        // Check solvency after locks
        if !invariants::verify_solvency(&state).is_ok() {
            failures += 1;
            eprintln!("SOLVENCY FAILURE after locking 8 trades");
        }

        // Release some, refund others
        for j in 0..8 {
            let id = make_trade_id(j);
            if j % 3 == 0 {
                state.advance_ledger(200);
                let _ = state.refund(id);
            } else if j % 3 == 1 {
                if let Some(secret) = secrets.get(&(j as u8)) {
                    let _ = state.release(id, *secret);
                }
            }
        }

        // Check solvency after operations
        if !invariants::verify_solvency(&state).is_ok() {
            failures += 1;
            eprintln!("SOLVENCY FAILURE after operations");
        }

        // Check conservation
        if !invariants::verify_conservation(&state, initial).is_ok() {
            failures += 1;
            eprintln!("CONSERVATION FAILURE in solvency test");
        }
    }

    // -----------------------------------------------------------------------
    // Phase 3: No-locked-funds invariant (every state is reachable to terminal)
    // -----------------------------------------------------------------------
    eprintln!("  Phase 3: No-locked-funds invariant...");
    for i in 0..iterations / 10 {
        let mut state = ReferenceState::new(1_000_000, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        let amount = ((i as i128) % 99_999) + 1;
        state.lock(id, 1, 2, amount, hash, 100);

        // Verify no-locked-funds: there must exist a path to terminal state
        // For Locked trades: release (with secret) or refund (after timeout)
        if !invariants::verify_no_locked_funds(&state).is_ok() {
            failures += 1;
            eprintln!("NO-LOCKED-FUNDS FAILURE for Locked trade");
        }

        // Raise dispute
        state.raise_dispute(id, 1);
        if !invariants::verify_no_locked_funds(&state).is_ok() {
            failures += 1;
            eprintln!("NO-LOCKED-FUNDS FAILURE for Disputed trade");
        }

        // Resolve it
        let _ = state.resolve_dispute(id, 5_000);
        if !invariants::verify_no_locked_funds(&state).is_ok() {
            failures += 1;
            eprintln!("NO-LOCKED-FUNDS FAILURE for Resolved trade");
        }
    }

    // -----------------------------------------------------------------------
    // Phase 4: Monotonic timelock invariant
    // -----------------------------------------------------------------------
    eprintln!("  Phase 4: Monotonic timelock invariant...");
    for _i in 0..iterations / 10 {
        let mut state = ReferenceState::new(1_000_000, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        state.lock(id, 1, 2, 500, hash, 100);

        // Advance ledger many times
        for _ in 0..100 {
            state.advance_ledger(50);
        }

        // Verify timelock constraints are still intact
        if !invariants::verify_monotonic_timelock(&state).is_ok() {
            failures += 1;
            eprintln!("MONOTONIC TIMELOCK FAILURE after 100 advances");
        }

        // The secret_hash and timeout_ledger should still be the original values
        let trade = state.trades.get(&id).unwrap();
        assert_eq!(trade.secret_hash, hash);
        assert_eq!(trade.timeout_ledger, 1100); // 1000 + 100
    }

    // -----------------------------------------------------------------------
    // Phase 5: Differential invariant verification
    // -----------------------------------------------------------------------
    eprintln!("  Phase 5: Differential invariant verification...");
    if let Err(e) = differential::fuzz_loop(iterations / 20, max_trades) {
        failures += 1;
        eprintln!("DIFFERENTIAL FAILURE: {}", e);
    }

    eprintln!(
        "Invariant fuzz complete: {} failures out of {} iterations",
        failures, iterations
    );

    if failures > 0 {
        process::exit(1);
    }
}

/// Execute operations with invariant checks after every step.
fn run_with_invariant_checks(ops: &[EscrowOp], initial: i128) -> Result<(), String> {
    let mut state = ReferenceState::new(initial, 100, 1000);
    let mut secrets: HashMap<u8, [u8; 32]> = HashMap::new();

    for (step, op) in ops.iter().enumerate() {
        match op {
            EscrowOp::Lock {
                trade_index,
                buyer,
                seller,
                amount,
                secret,
                timeout_ledgers,
            } => {
                let id = make_trade_id(*trade_index);
                let hash = make_secret_hash(secret);
                secrets.insert(*trade_index, *secret);
                state.lock(id, *buyer, *seller, *amount, hash, *timeout_ledgers);
            }
            EscrowOp::Release {
                trade_index,
                secret,
            } => {
                let id = make_trade_id(*trade_index);
                state.release(id, *secret);
            }
            EscrowOp::Refund { trade_index } => {
                let id = make_trade_id(*trade_index);
                state.refund(id);
            }
            EscrowOp::RaiseDispute {
                trade_index,
                caller,
            } => {
                let id = make_trade_id(*trade_index);
                state.raise_dispute(id, *caller);
            }
            EscrowOp::ResolveDispute {
                trade_index,
                buyer_share_bps,
            } => {
                let id = make_trade_id(*trade_index);
                state.resolve_dispute(id, *buyer_share_bps);
            }
            EscrowOp::RefundAfterDisputeTimeout { trade_index } => {
                let id = make_trade_id(*trade_index);
                state.refund_after_dispute_timeout(id);
            }
            EscrowOp::AdvanceLedger { delta } => {
                state.advance_ledger(*delta);
            }
        }

        // Check all invariants after every step
        invariants::verify_all(&state, initial)
            .map_err(|e| format!("step {}: {}", step, e))?;
    }

    Ok(())
}

fn generate_random_ops(max_trades: usize, seed: u64) -> Vec<EscrowOp> {
    let mut ops = Vec::new();
    let num_ops = ((seed % 40) + 5) as usize;

    for i in 0..num_ops {
        let s = seed
            .wrapping_add(i as u64)
            .wrapping_mul(0xBF58476D1CE4E5B9);
        let trade_idx = (s % max_trades as u64) as u8;
        let secret_seed = (s >> 8) as u8;
        let op_type = s % 11;

        match op_type {
            0 => {
                let amount = ((s >> 16) % 99_999) as i128 + 1;
                let timeout = ((s >> 24) % 499) as u32 + 1;
                ops.push(EscrowOp::Lock {
                    trade_index: trade_idx,
                    buyer: 1,
                    seller: 2,
                    amount,
                    secret: make_secret(secret_seed),
                    timeout_ledgers: timeout,
                });
            }
            1 => ops.push(EscrowOp::Release {
                trade_index: trade_idx,
                secret: make_secret(secret_seed),
            }),
            2 => ops.push(EscrowOp::Release {
                trade_index: trade_idx,
                secret: make_secret(secret_seed.wrapping_add(129)),
            }),
            3 => ops.push(EscrowOp::Refund {
                trade_index: trade_idx,
            }),
            4 => ops.push(EscrowOp::RaiseDispute {
                trade_index: trade_idx,
                caller: 1,
            }),
            5 => ops.push(EscrowOp::RaiseDispute {
                trade_index: trade_idx,
                caller: 2,
            }),
            6 => ops.push(EscrowOp::ResolveDispute {
                trade_index: trade_idx,
                buyer_share_bps: 5_000,
            }),
            7 => ops.push(EscrowOp::ResolveDispute {
                trade_index: trade_idx,
                buyer_share_bps: 10_000,
            }),
            8 => ops.push(EscrowOp::ResolveDispute {
                trade_index: trade_idx,
                buyer_share_bps: 0,
            }),
            9 => ops.push(EscrowOp::RefundAfterDisputeTimeout {
                trade_index: trade_idx,
            }),
            _ => {
                let delta = ((s >> 16) % 600) as u32;
                ops.push(EscrowOp::AdvanceLedger { delta });
            }
        }
    }

    ops
}
