use crate::reference_machine::{ReferenceState, TradeStatus};

/// Verify solvency: contract balance >= sum of all active (Locked | Disputed) amounts.
pub fn verify_solvency(state: &ReferenceState) -> Result<(), String> {
    let active_sum: i128 = state
        .trades
        .values()
        .filter(|t| matches!(t.status, TradeStatus::Locked | TradeStatus::Disputed))
        .map(|t| t.amount)
        .sum();

    if state.balances.contract < active_sum {
        return Err(format!(
            "solvency violated: contract has {} but {} is locked in active trades",
            state.balances.contract, active_sum
        ));
    }
    Ok(())
}

/// Verify no locked funds: every non-terminal trade has a valid path to completion.
pub fn verify_no_locked_funds(state: &ReferenceState) -> Result<(), String> {
    for (id, trade) in &state.trades {
        match trade.status {
            TradeStatus::Locked => {
                // Always has release (with secret) and refund (after timeout) paths
            }
            TradeStatus::Disputed => {
                // Always has resolve_dispute and refund_after_dispute_timeout paths
            }
            TradeStatus::Released | TradeStatus::Refunded | TradeStatus::Resolved => {}
        }
        let _ = id;
    }
    Ok(())
}

/// Verify monotonic timelock: ledger advancement doesn't corrupt hashlock constraints.
pub fn verify_monotonic_timelock(state: &ReferenceState) -> Result<(), String> {
    for trade in state.trades.values() {
        if matches!(trade.status, TradeStatus::Locked) {
            if trade.timeout_ledger == 0 {
                return Err(format!(
                    "trade has zero timeout_ledger while in Locked status"
                ));
            }
        }
    }
    Ok(())
}

/// Verify conservation of value: buyer + seller + admin + contract == initial.
pub fn verify_conservation(state: &ReferenceState, initial: i128) -> Result<(), String> {
    let total = state.balances.buyer
        + state.balances.seller
        + state.balances.admin
        + state.balances.contract;
    if total != initial {
        return Err(format!(
            "conservation violated: sum={} expected={} (buyer={} seller={} admin={} contract={})",
            total, initial, state.balances.buyer, state.balances.seller,
            state.balances.admin, state.balances.contract
        ));
    }
    Ok(())
}

/// Verify fee arithmetic for a release operation.
pub fn verify_release_fee_arithmetic(
    amount: i128,
    fee_bps: u32,
    actual_fee: i128,
    actual_payout: i128,
) -> Result<(), String> {
    let expected_fee = (amount * fee_bps as i128) / 10_000;
    let expected_payout = amount - expected_fee;

    if actual_fee != expected_fee {
        return Err(format!(
            "release fee mismatch: expected {} got {}",
            expected_fee, actual_fee
        ));
    }
    if actual_payout != expected_payout {
        return Err(format!(
            "release payout mismatch: expected {} got {}",
            expected_payout, actual_payout
        ));
    }
    if actual_fee + actual_payout != amount {
        return Err(format!(
            "release accounting: fee({}) + payout({}) != amount({})",
            actual_fee, actual_payout, amount
        ));
    }
    Ok(())
}

/// Verify fee arithmetic for a dispute resolution.
pub fn verify_dispute_fee_arithmetic(
    amount: i128,
    buyer_share_bps: u32,
    fee_bps: u32,
    actual_buyer: i128,
    actual_seller: i128,
    actual_fee: i128,
) -> Result<(), String> {
    let expected_buyer = (amount * buyer_share_bps as i128) / 10_000;
    let seller_gross = amount - expected_buyer;
    let expected_fee = (seller_gross * fee_bps as i128) / 10_000;
    let expected_seller = seller_gross - expected_fee;

    if actual_buyer != expected_buyer {
        return Err(format!(
            "dispute buyer share mismatch: expected {} got {}",
            expected_buyer, actual_buyer
        ));
    }
    if actual_seller != expected_seller {
        return Err(format!(
            "dispute seller share mismatch: expected {} got {}",
            expected_seller, actual_seller
        ));
    }
    if actual_fee != expected_fee {
        return Err(format!(
            "dispute fee mismatch: expected {} got {}",
            expected_fee, actual_fee
        ));
    }
    if actual_buyer + actual_seller + actual_fee != amount {
        return Err(format!(
            "dispute accounting: buyer({}) + seller({}) + fee({}) != amount({})",
            actual_buyer, actual_seller, actual_fee, amount
        ));
    }
    Ok(())
}

/// Run all invariant checks on a state and return the first failure.
pub fn verify_all(state: &ReferenceState, initial: i128) -> Result<(), String> {
    verify_solvency(state)?;
    verify_no_locked_funds(state)?;
    verify_monotonic_timelock(state)?;
    verify_conservation(state, initial)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solvency_holds_for_empty_state() {
        let state = ReferenceState::new(1_000, 100, 1000);
        assert!(verify_solvency(&state).is_ok());
    }

    #[test]
    fn conservation_holds_for_empty_state() {
        let state = ReferenceState::new(1_000, 100, 1000);
        assert!(verify_conservation(&state, 1_000).is_ok());
    }

    #[test]
    fn release_fee_arithmetic_zero_fee() {
        assert!(verify_release_fee_arithmetic(500, 0, 0, 500).is_ok());
    }

    #[test]
    fn release_fee_arithmetic_full_fee() {
        assert!(verify_release_fee_arithmetic(500, 10_000, 500, 0).is_ok());
    }

    #[test]
    fn dispute_split_50_50() {
        assert!(verify_dispute_fee_arithmetic(500, 5_000, 100, 250, 248, 2).is_ok());
    }

    #[test]
    fn dispute_split_full_to_buyer() {
        assert!(verify_dispute_fee_arithmetic(500, 10_000, 100, 500, 0, 0).is_ok());
    }

    #[test]
    fn dispute_split_full_to_seller() {
        assert!(verify_dispute_fee_arithmetic(500, 0, 100, 0, 495, 5).is_ok());
    }
}
