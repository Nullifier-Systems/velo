use proptest::prelude::*;

/// Represents a single operation in an escrow state machine sequence.
#[derive(Clone, Debug)]
pub enum EscrowOp {
    Lock {
        trade_index: u8,
        buyer: u64,
        seller: u64,
        amount: i128,
        secret: [u8; 32],
        timeout_ledgers: u32,
    },
    Release {
        trade_index: u8,
        secret: [u8; 32],
    },
    Refund {
        trade_index: u8,
    },
    RaiseDispute {
        trade_index: u8,
        caller: u64,
    },
    ResolveDispute {
        trade_index: u8,
        buyer_share_bps: u32,
    },
    RefundAfterDisputeTimeout {
        trade_index: u8,
    },
    AdvanceLedger {
        delta: u32,
    },
}

/// Configuration for generating operation sequences.
#[derive(Clone, Debug)]
pub struct FuzzConfig {
    pub num_trades: usize,
    pub max_amount: i128,
    pub fee_bps: u32,
    pub start_ledger: u32,
}

impl Default for FuzzConfig {
    fn default() -> Self {
        Self {
            num_trades: 8,
            max_amount: 100_000,
            fee_bps: 100,
            start_ledger: 1000,
        }
    }
}

/// Generate a secret as a 32-byte array from a single byte seed.
pub fn make_secret(seed: u8) -> [u8; 32] {
    let mut s = [0u8; 32];
    s[0] = seed;
    // Fill rest with deterministic pattern for good hash distribution
    for i in 1..32 {
        s[i] = seed.wrapping_add(i as u8).wrapping_mul(0x9E);
    }
    s
}

/// Generate a secret hash from a secret.
pub fn make_secret_hash(secret: &[u8; 32]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(secret);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Generate a trade ID from an index.
pub fn make_trade_id(index: u8) -> [u8; 32] {
    let mut id = [0u8; 32];
    id[0] = index;
    id
}

/// Strategy for generating random escrow operation sequences.
pub fn arb_escrow_ops(max_trades: usize) -> impl Strategy<Value = Vec<EscrowOp>> {
    let num_ops = 1..65usize;
    num_ops.prop_flat_map(move |n| {
        prop::collection::vec(arb_single_op(max_trades), 1..=n)
    })
}

/// Strategy for a single escrow operation.
fn arb_single_op(max_trades: usize) -> impl Strategy<Value = EscrowOp> {
    prop_oneof![
        // Lock
        (0..max_trades as u8, any::<u8>(), any::<u64>(), any::<u64>(), 1i128..100_000, 1u32..500)
            .prop_map(|(idx, secret_seed, buyer, seller, amount, timeout)| {
                EscrowOp::Lock {
                    trade_index: idx,
                    buyer,
                    seller,
                    amount,
                    secret: make_secret(secret_seed),
                    timeout_ledgers: timeout,
                }
            }),
        // Release with correct secret
        (0..max_trades as u8, any::<u8>())
            .prop_map(|(idx, secret_seed)| EscrowOp::Release {
                trade_index: idx,
                secret: make_secret(secret_seed),
            }),
        // Release with wrong secret
        (0..max_trades as u8, any::<u8>())
            .prop_map(|(idx, secret_seed)| EscrowOp::Release {
                trade_index: idx,
                secret: make_secret(secret_seed.wrapping_add(129)),
            }),
        // Refund
        (0..max_trades as u8).prop_map(|idx| EscrowOp::Refund { trade_index: idx }),
        // Raise dispute by buyer (caller=1)
        (0..max_trades as u8).prop_map(|idx| EscrowOp::RaiseDispute {
            trade_index: idx,
            caller: 1,
        }),
        // Raise dispute by seller (caller=2)
        (0..max_trades as u8).prop_map(|idx| EscrowOp::RaiseDispute {
            trade_index: idx,
            caller: 2,
        }),
        // Resolve dispute 50/50
        (0..max_trades as u8).prop_map(|idx| EscrowOp::ResolveDispute {
            trade_index: idx,
            buyer_share_bps: 5_000,
        }),
        // Resolve dispute full to buyer
        (0..max_trades as u8).prop_map(|idx| EscrowOp::ResolveDispute {
            trade_index: idx,
            buyer_share_bps: 10_000,
        }),
        // Resolve dispute full to seller
        (0..max_trades as u8).prop_map(|idx| EscrowOp::ResolveDispute {
            trade_index: idx,
            buyer_share_bps: 0,
        }),
        // Refund after dispute timeout
        (0..max_trades as u8).prop_map(|idx| EscrowOp::RefundAfterDisputeTimeout { trade_index: idx }),
        // Advance ledger
        (0u32..600).prop_map(|delta| EscrowOp::AdvanceLedger { delta }),
    ]
}

/// Execute a sequence of operations against a reference state machine.
pub fn execute_ops(
    state: &mut crate::reference_machine::ReferenceState,
    ops: &[EscrowOp],
    secrets: &mut std::collections::HashMap<u8, [u8; 32]>,
) -> Vec<crate::reference_machine::TransitionResult> {

    let mut results = Vec::new();

    for op in ops {
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
                results.push(state.lock(id, *buyer, *seller, *amount, hash, *timeout_ledgers));
            }
            EscrowOp::Release {
                trade_index,
                secret,
            } => {
                let id = make_trade_id(*trade_index);
                results.push(state.release(id, *secret));
            }
            EscrowOp::Refund { trade_index } => {
                let id = make_trade_id(*trade_index);
                results.push(state.refund(id));
            }
            EscrowOp::RaiseDispute {
                trade_index,
                caller,
            } => {
                let id = make_trade_id(*trade_index);
                results.push(state.raise_dispute(id, *caller));
            }
            EscrowOp::ResolveDispute {
                trade_index,
                buyer_share_bps,
            } => {
                let id = make_trade_id(*trade_index);
                results.push(state.resolve_dispute(id, *buyer_share_bps));
            }
            EscrowOp::RefundAfterDisputeTimeout { trade_index } => {
                let id = make_trade_id(*trade_index);
                results.push(state.refund_after_dispute_timeout(id));
            }
            EscrowOp::AdvanceLedger { delta } => {
                state.advance_ledger(*delta);
                results.push(crate::reference_machine::TransitionResult::Ok);
            }
        }
    }

    results
}
