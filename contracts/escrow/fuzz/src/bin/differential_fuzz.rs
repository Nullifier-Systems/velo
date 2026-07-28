use escrow_fuzz_lib::differential;
use escrow_fuzz_lib::state_generator::{make_secret, EscrowOp};
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
        "Running differential fuzz: {} iterations, max {} trades",
        iterations, max_trades
    );

    let config = differential::DifferentialConfig {
        initial_balance: 1_000_000,
        fee_bps: 100,
        start_ledger: 1000,
    };

    let mut failures = 0u64;

    for i in 0..iterations {
        let ops = generate_random_ops(max_trades);

        match differential::differential_round(&ops, &config) {
            Ok(_) => {
                if (i + 1) % 1000 == 0 {
                    eprintln!("  [+] {} iterations passed", i + 1);
                }
            }
            Err(e) => {
                failures += 1;
                eprintln!("FAILURE at iteration {}: {}", i, e);
                eprintln!("  Operations:");
                for (j, op) in ops.iter().enumerate() {
                    eprintln!("    {}: {:?}", j, op);
                }
                if failures > 10 {
                    eprintln!("Too many failures, aborting.");
                    process::exit(1);
                }
            }
        }
    }

    eprintln!(
        "Differential fuzz complete: {}/{} iterations passed, {} failures",
        iterations - failures as usize,
        iterations,
        failures
    );

    if failures > 0 {
        process::exit(1);
    }
}

/// Generate random operations using a simple PRNG for standalone fuzzing
/// (without proptest dependency in the binary).
fn generate_random_ops(max_trades: usize) -> Vec<EscrowOp> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    std::time::SystemTime::now()
        .hash(&mut hasher);
    let seed = hasher.finish();

    let num_ops = ((seed % 32) + 1) as usize;
    let mut ops = Vec::with_capacity(num_ops);

    for i in 0..num_ops {
        let op_seed = seed.wrapping_add(i as u64).wrapping_mul(0x9E3779B97F4A7C15);
        let trade_idx = (op_seed % max_trades as u64) as u8;
        let secret_seed = (op_seed >> 8) as u8;

        let op_type = op_seed % 11;

        match op_type {
            0 => {
                let amount = ((op_seed >> 16) % 99_999) as i128 + 1;
                let timeout = ((op_seed >> 24) % 499) as u32 + 1;
                ops.push(EscrowOp::Lock {
                    trade_index: trade_idx,
                    buyer: 1,
                    seller: 2,
                    amount,
                    secret: make_secret(secret_seed),
                    timeout_ledgers: timeout,
                });
            }
            1 => {
                ops.push(EscrowOp::Release {
                    trade_index: trade_idx,
                    secret: make_secret(secret_seed),
                });
            }
            2 => {
                ops.push(EscrowOp::Release {
                    trade_index: trade_idx,
                    secret: make_secret(secret_seed.wrapping_add(129)),
                });
            }
            3 => {
                ops.push(EscrowOp::Refund {
                    trade_index: trade_idx,
                });
            }
            4 => {
                ops.push(EscrowOp::RaiseDispute {
                    trade_index: trade_idx,
                    caller: 1,
                });
            }
            5 => {
                ops.push(EscrowOp::RaiseDispute {
                    trade_index: trade_idx,
                    caller: 2,
                });
            }
            6 => {
                ops.push(EscrowOp::ResolveDispute {
                    trade_index: trade_idx,
                    buyer_share_bps: 5_000,
                });
            }
            7 => {
                ops.push(EscrowOp::ResolveDispute {
                    trade_index: trade_idx,
                    buyer_share_bps: 10_000,
                });
            }
            8 => {
                ops.push(EscrowOp::ResolveDispute {
                    trade_index: trade_idx,
                    buyer_share_bps: 0,
                });
            }
            9 => {
                ops.push(EscrowOp::RefundAfterDisputeTimeout {
                    trade_index: trade_idx,
                });
            }
            _ => {
                let delta = ((op_seed >> 16) % 600) as u32;
                ops.push(EscrowOp::AdvanceLedger { delta });
            }
        }
    }

    ops
}
