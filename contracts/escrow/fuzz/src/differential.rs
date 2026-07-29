use crate::invariants;
use crate::reference_machine::ReferenceState;
use crate::state_generator::EscrowOp;
use std::collections::HashMap;

/// Run a differential fuzzing round: execute the same operation sequence
/// on two independent reference state machines and verify they produce
/// identical results and maintain all invariants.
pub fn differential_round(
    ops: &[EscrowOp],
    config: &DifferentialConfig,
) -> Result<DifferentialResult, String> {
    let mut state_a = ReferenceState::new(
        config.initial_balance,
        config.fee_bps,
        config.start_ledger,
    );
    let mut state_b = ReferenceState::new(
        config.initial_balance,
        config.fee_bps,
        config.start_ledger,
    );

    let mut secrets_a: HashMap<u8, [u8; 32]> = HashMap::new();
    let mut secrets_b: HashMap<u8, [u8; 32]> = HashMap::new();

    let results_a = crate::state_generator::execute_ops(&mut state_a, ops, &mut secrets_a);
    let results_b = crate::state_generator::execute_ops(&mut state_b, ops, &mut secrets_b);

    // Verify determinism: both machines must produce identical results
    if results_a.len() != results_b.len() {
        return Err(format!(
            "result count mismatch: {} vs {}",
            results_a.len(),
            results_b.len()
        ));
    }

    for (i, (ra, rb)) in results_a.iter().zip(results_b.iter()).enumerate() {
        if std::mem::discriminant(ra) != std::mem::discriminant(rb) {
            return Err(format!(
                "result mismatch at step {}: {:?} vs {:?}",
                i, ra, rb
            ));
        }
    }

    // Verify final state consistency
    if state_a.balances.contract != state_b.balances.contract {
        return Err(format!(
            "contract balance divergence: {} vs {}",
            state_a.balances.contract, state_b.balances.contract
        ));
    }
    if state_a.balances.buyer != state_b.balances.buyer {
        return Err(format!(
            "buyer balance divergence: {} vs {}",
            state_a.balances.buyer, state_b.balances.buyer
        ));
    }
    if state_a.balances.seller != state_b.balances.seller {
        return Err(format!(
            "seller balance divergence: {} vs {}",
            state_a.balances.seller, state_b.balances.seller
        ));
    }

    // Verify all invariants on final state
    invariants::verify_all(&state_a, config.initial_balance)?;

    Ok(DifferentialResult {
        steps: ops.len(),
        state: state_a,
    })
}

pub struct DifferentialConfig {
    pub initial_balance: i128,
    pub fee_bps: u32,
    pub start_ledger: u32,
}

pub struct DifferentialResult {
    pub steps: usize,
    pub state: ReferenceState,
}

/// Run a high-volume fuzzing loop: generate random operation sequences
/// and verify invariants hold for each.
pub fn fuzz_loop(iterations: usize, max_trades: usize) -> Result<(), String> {
    use proptest::prelude::*;
    use proptest::strategy::ValueTree;

    let mut runner = proptest::test_runner::TestRunner::default();
    let strategy = crate::state_generator::arb_escrow_ops(max_trades);

    for _ in 0..iterations {
        let ops = strategy.new_tree(&mut runner).unwrap().current();

        let config = DifferentialConfig {
            initial_balance: 1_000_000,
            fee_bps: 100,
            start_ledger: 1000,
        };

        differential_round(&ops, &config).map_err(|e| {
            format!(
                "differential fuzz failure after {} steps: {}\nops: {:?}",
                ops.len(),
                e,
                ops.iter()
                    .enumerate()
                    .map(|(i, op)| format!("  {}: {:?}", i, op))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        })?;
    }

    Ok(())
}

/// Specialized fuzzing for fee arithmetic edge cases.
pub fn fuzz_fee_arithmetic(iterations: usize) -> Result<(), String> {
    use proptest::prelude::*;
    use proptest::strategy::ValueTree;

    let mut runner = proptest::test_runner::TestRunner::default();
    let strategy = (1i128..=(i128::MAX / 10_000), 0u32..=10_000);

    for _ in 0..iterations {
        let (amount, fee_bps) = strategy.new_tree(&mut runner).unwrap().current();

        let fee = (amount * fee_bps as i128) / 10_000;
        let payout = amount - fee;

        if fee < 0 {
            return Err(format!("negative fee: amount={} fee_bps={} fee={}", amount, fee_bps, fee));
        }
        if payout < 0 {
            return Err(format!("negative payout: amount={} fee_bps={} payout={}", amount, fee_bps, payout));
        }
        if fee + payout != amount {
            return Err(format!(
                "accounting error: fee({}) + payout({}) != amount({})",
                fee, payout, amount
            ));
        }

        // Rounding check: truncation means actual fee <= ideal fee
        if fee * 10_000 > amount * fee_bps as i128 {
            return Err(format!(
                "rounding error: fee*10000({}) > amount*bps({})",
                fee * 10_000,
                amount * fee_bps as i128
            ));
        }
    }

    Ok(())
}

/// Specialized fuzzing for dispute split arithmetic.
pub fn fuzz_split_arithmetic(iterations: usize) -> Result<(), String> {
    use proptest::prelude::*;
    use proptest::strategy::ValueTree;

    let mut runner = proptest::test_runner::TestRunner::default();
    let strategy = (1i128..=(i128::MAX / 10_000), 0u32..=10_000, 0u32..=10_000);

    for _ in 0..iterations {
        let (amount, buyer_share_bps, fee_bps) = strategy.new_tree(&mut runner).unwrap().current();

        let buyer_amount = (amount * buyer_share_bps as i128) / 10_000;
        let seller_gross = amount - buyer_amount;
        let fee = (seller_gross * fee_bps as i128) / 10_000;
        let seller_payout = seller_gross - fee;

        if buyer_amount < 0 || seller_gross < 0 || fee < 0 || seller_payout < 0 {
            return Err(format!(
                "negative value: buyer={} seller_gross={} fee={} payout={}",
                buyer_amount, seller_gross, fee, seller_payout
            ));
        }

        let total = buyer_amount + seller_payout + fee;
        if total != amount {
            return Err(format!(
                "split accounting error: buyer({}) + seller({}) + fee({}) != amount({})",
                buyer_amount, seller_payout, fee, amount
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state_generator::make_secret;
    use crate::state_generator::EscrowOp;

    #[test]
    fn deterministic_execution() {
        let ops = vec![
            EscrowOp::Lock {
                trade_index: 0,
                buyer: 1,
                seller: 2,
                amount: 500,
                secret: make_secret(7),
                timeout_ledgers: 100,
            },
            EscrowOp::Release {
                trade_index: 0,
                secret: make_secret(7),
            },
        ];

        let config = DifferentialConfig {
            initial_balance: 1_000,
            fee_bps: 100,
            start_ledger: 1000,
        };

        let result = differential_round(&ops, &config);
        assert!(result.is_ok());
        let result = result.unwrap();
        assert_eq!(result.steps, 2);
        assert_eq!(result.state.balances.seller, 495);
        assert_eq!(result.state.balances.admin, 5);
        assert_eq!(result.state.balances.contract, 0);
    }

    #[test]
    fn conservation_after_complex_sequence() {
        let ops = vec![
            EscrowOp::Lock {
                trade_index: 0,
                buyer: 1,
                seller: 2,
                amount: 500,
                secret: make_secret(7),
                timeout_ledgers: 100,
            },
            EscrowOp::Lock {
                trade_index: 1,
                buyer: 1,
                seller: 3,
                amount: 300,
                secret: make_secret(8),
                timeout_ledgers: 200,
            },
            EscrowOp::RaiseDispute {
                trade_index: 0,
                caller: 1,
            },
            EscrowOp::ResolveDispute {
                trade_index: 0,
                buyer_share_bps: 5_000,
            },
            EscrowOp::Release {
                trade_index: 1,
                secret: make_secret(8),
            },
        ];

        let config = DifferentialConfig {
            initial_balance: 1_000,
            fee_bps: 100,
            start_ledger: 1000,
        };

        let result = differential_round(&ops, &config);
        assert!(result.is_ok());
    }

    #[test]
    fn ledger_advance_refund_flow() {
        let ops = vec![
            EscrowOp::Lock {
                trade_index: 0,
                buyer: 1,
                seller: 2,
                amount: 500,
                secret: make_secret(7),
                timeout_ledgers: 100,
            },
            EscrowOp::AdvanceLedger { delta: 101 },
            EscrowOp::Refund { trade_index: 0 },
        ];

        let config = DifferentialConfig {
            initial_balance: 1_000,
            fee_bps: 100,
            start_ledger: 1000,
        };

        let result = differential_round(&ops, &config);
        assert!(result.is_ok());
        let result = result.unwrap();
        assert_eq!(result.state.balances.buyer, 1_000);
        assert_eq!(result.state.balances.contract, 0);
    }
}
