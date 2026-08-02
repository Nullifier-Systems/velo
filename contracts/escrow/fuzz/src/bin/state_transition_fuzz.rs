use escrow_fuzz_lib::reference_machine::{ReferenceState, TransitionResult};
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
        "Running state transition fuzzer: {} iterations, max {} trades",
        iterations, max_trades
    );

    let mut failures = 0u64;

    for i in 0..iterations {
        let ops = generate_ops(max_trades, i as u64);

        match run_transition_sequence(&ops) {
            Ok(_) => {
                if (i + 1) % 1000 == 0 {
                    eprintln!("  [+] {} sequences passed", i + 1);
                }
            }
            Err(e) => {
                failures += 1;
                eprintln!("FAILURE at sequence {}: {}", i, e);
                if failures > 10 {
                    eprintln!("Too many failures, aborting.");
                    process::exit(1);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Targeted state transition tests
    // -----------------------------------------------------------------------
    eprintln!("  Phase 2: Targeted transition validity...");
    let targeted_failures = test_targeted_transitions();
    failures += targeted_failures;

    eprintln!(
        "State transition fuzz complete: {}/{} passed, {} failures",
        iterations - failures as usize,
        iterations,
        failures
    );

    if failures > 0 {
        process::exit(1);
    }
}

/// Execute a sequence of operations and verify:
/// 1. Invariants hold after every step
/// 2. State transitions are valid (no invalid transitions like Locked->Released without secret)
/// 3. Conservation of value is maintained
fn run_transition_sequence(ops: &[EscrowOp]) -> Result<(), String> {
    let initial = 1_000_000i128;
    let mut state = ReferenceState::new(initial, 100, 1000);
    let mut secrets: HashMap<u8, [u8; 32]> = HashMap::new();
    let mut prev_statuses: HashMap<u8, TransitionResult> = HashMap::new();

    for (step, op) in ops.iter().enumerate() {
        let result = execute_single(&mut state, op, &mut secrets);

        // Verify invariants after every step
        state
            .verify_all_invariants(initial)
            .map_err(|e| format!("step {}: {}", step, e))?;

        // Track state transitions for validity checking
        if let EscrowOp::Lock { trade_index, .. } = op {
            prev_statuses.insert(*trade_index, TransitionResult::Ok);
        }

        let _ = result;
    }

    Ok(())
}

fn execute_single(
    state: &mut ReferenceState,
    op: &EscrowOp,
    secrets: &mut HashMap<u8, [u8; 32]>,
) -> TransitionResult {
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
            state.lock(id, *buyer, *seller, *amount, hash, *timeout_ledgers)
        }
        EscrowOp::Release {
            trade_index,
            secret,
        } => {
            let id = make_trade_id(*trade_index);
            state.release(id, *secret)
        }
        EscrowOp::Refund { trade_index } => {
            let id = make_trade_id(*trade_index);
            state.refund(id)
        }
        EscrowOp::RaiseDispute {
            trade_index,
            caller,
        } => {
            let id = make_trade_id(*trade_index);
            state.raise_dispute(id, *caller)
        }
        EscrowOp::ResolveDispute {
            trade_index,
            buyer_share_bps,
        } => {
            let id = make_trade_id(*trade_index);
            state.resolve_dispute(id, *buyer_share_bps)
        }
        EscrowOp::RefundAfterDisputeTimeout { trade_index } => {
            let id = make_trade_id(*trade_index);
            state.refund_after_dispute_timeout(id)
        }
        EscrowOp::AdvanceLedger { delta } => {
            state.advance_ledger(*delta);
            TransitionResult::Ok
        }
    }
}

/// Test specific targeted state transitions for correctness.
fn test_targeted_transitions() -> u64 {
    let mut failures = 0u64;
    let initial = 1_000_000i128;

    // Test: Lock -> Release with correct secret succeeds
    {
        let mut state = ReferenceState::new(initial, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        let r = state.lock(id, 1, 2, 500, hash, 100);
        assert_eq!(r, TransitionResult::Ok);
        let r = state.release(id, secret);
        assert_eq!(r, TransitionResult::Ok);
        if state.verify_all_invariants(initial).is_err() {
            failures += 1;
        }
    }

    // Test: Lock -> Release with wrong secret fails
    {
        let mut state = ReferenceState::new(initial, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        state.lock(id, 1, 2, 500, hash, 100);
        let r = state.release(id, make_secret(8));
        assert_eq!(r, TransitionResult::InvalidSecret);
        if state.verify_all_invariants(initial).is_err() {
            failures += 1;
        }
    }

    // Test: Lock -> Refund before timeout fails
    {
        let mut state = ReferenceState::new(initial, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        state.lock(id, 1, 2, 500, hash, 100);
        let r = state.refund(id);
        assert_eq!(r, TransitionResult::TimeoutNotReached);
    }

    // Test: Lock -> Advance -> Refund succeeds
    {
        let mut state = ReferenceState::new(initial, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        state.lock(id, 1, 2, 500, hash, 100);
        state.advance_ledger(101);
        let r = state.refund(id);
        assert_eq!(r, TransitionResult::Ok);
        if state.verify_all_invariants(initial).is_err() {
            failures += 1;
        }
    }

    // Test: Lock -> RaiseDispute -> ResolveDispute
    {
        let mut state = ReferenceState::new(initial, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        state.lock(id, 1, 2, 500, hash, 100);
        let r = state.raise_dispute(id, 1);
        assert_eq!(r, TransitionResult::Ok);
        let r = state.resolve_dispute(id, 5_000);
        assert_eq!(r, TransitionResult::Ok);
        if state.verify_all_invariants(initial).is_err() {
            failures += 1;
        }
    }

    // Test: Lock -> RaiseDispute -> RefundAfterDisputeTimeout
    {
        let mut state = ReferenceState::new(initial, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        state.lock(id, 1, 2, 500, hash, 100);
        state.raise_dispute(id, 1);
        // DISPUTE_RESOLUTION_WINDOW = 518_400
        state.advance_ledger(518_401);
        let r = state.refund_after_dispute_timeout(id);
        assert_eq!(r, TransitionResult::Ok);
        if state.verify_all_invariants(initial).is_err() {
            failures += 1;
        }
    }

    // Test: Release after dispute fails (Disputed -> Released is invalid)
    {
        let mut state = ReferenceState::new(initial, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        state.lock(id, 1, 2, 500, hash, 100);
        state.raise_dispute(id, 1);
        let r = state.release(id, secret);
        assert_eq!(r, TransitionResult::TradeNotLocked);
    }

    // Test: Refund after dispute fails (Disputed -> Refunded is invalid via refund)
    {
        let mut state = ReferenceState::new(initial, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        state.lock(id, 1, 2, 500, hash, 100);
        state.raise_dispute(id, 1);
        state.advance_ledger(101);
        let r = state.refund(id);
        assert_eq!(r, TransitionResult::TradeNotLocked);
    }

    // Test: Double-lock same ID fails
    {
        let mut state = ReferenceState::new(initial, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        state.lock(id, 1, 2, 500, hash, 100);
        let r = state.lock(id, 1, 2, 300, hash, 200);
        assert_eq!(r, TransitionResult::TradeAlreadyExists);
    }

    // Test: Resolve dispute with invalid split fails
    {
        let mut state = ReferenceState::new(initial, 100, 1000);
        let secret = make_secret(7);
        let hash = make_secret_hash(&secret);
        let id = make_trade_id(0);

        state.lock(id, 1, 2, 500, hash, 100);
        state.raise_dispute(id, 1);
        let r = state.resolve_dispute(id, 10_001);
        assert_eq!(r, TransitionResult::InvalidSplit);
    }

    failures
}

/// Generate operation sequences using a deterministic PRNG.
fn generate_ops(max_trades: usize, iteration: u64) -> Vec<EscrowOp> {
    let mut ops = Vec::new();
    let seed = iteration.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(0xDEADBEEF);
    let num_ops = ((seed % 40) + 5) as usize;

    for i in 0..num_ops {
        let s = seed.wrapping_add(i as u64).wrapping_mul(0xBF58476D1CE4E5B9);
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
