//! Reputation-side MST proof verification tests (issue #387).
//!
//! `htlc_core::mst`'s own unit tests (in `contracts/htlc-core/src/mst.rs`)
//! cover the tree primitives (hashing, combination, tamper detection) in
//! isolation. This file exercises the same properties one layer up, at the
//! `verify_and_aggregate` / `compute_score` / `compute_score_incremental`
//! integration points specific to the reputation contract — including the
//! self-trade exclusion, which only exists at this layer.
//!
//! No property-testing crate is introduced here (the reputation crate has
//! none as a dev-dependency, unlike `escrow`, which already depends on
//! `proptest`) — "randomized ... verification" is exercised with a small
//! deterministic xorshift32 PRNG instead, consistent with how
//! `htlc_core::mst`'s own tests do it.
use super::*;
use crate::test::{setup_contract, setup_env, setup_escrow_trades};
use htlc_core::mst::{LeafProof, MstSibling};
use htlc_core::TradeStatus;
use soroban_sdk::testutils::Address as _;

extern crate std;

fn make_leaf(
    env: &Env,
    seller: &Address,
    buyer: &Address,
    amount: i128,
    status: u32,
    ledger: u32,
) -> mst::ReputationLeaf {
    mst::ReputationLeaf {
        trade_id_hash: BytesN::from_array(env, &[9u8; 32]),
        amount,
        status_bits: status,
        counterparty_hash: mst::counterparty_hash(env, seller, buyer),
        ledger,
    }
}

/// Builds a one-leaf tree (all-zero siblings) and the `ScoreProof` batch
/// containing it, returning the resulting root alongside the proof.
fn single_leaf_proof(env: &Env, leaf: &mst::ReputationLeaf, index: u32) -> (BytesN<32>, ScoreProof) {
    let mut siblings = Vec::new(env);
    for _ in 0..mst::MST_DEPTH {
        siblings.push_back(MstSibling {
            hash: BytesN::from_array(env, &[0u8; 32]),
            sum: 0,
        });
    }
    let (root, _sum) = mst::recompute_root(env, leaf, index, &siblings).unwrap();

    let mut proofs = Vec::new(env);
    proofs.push_back(LeafProof {
        leaf: leaf.clone(),
        leaf_index: index,
        siblings,
    });
    (root, ScoreProof { proofs })
}

#[test]
fn verify_and_aggregate_counts_a_valid_leaf() {
    let env = Env::default();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);
    let leaf = make_leaf(&env, &seller, &buyer, 500, mst::STATUS_RELEASED, 10);
    let (root, proof) = single_leaf_proof(&env, &leaf, 3);

    let (total, completed, disputed, volume, counterparties, last_ledger) =
        verify_and_aggregate(&env, &proof, &root, &seller);

    assert_eq!(total, 1);
    assert_eq!(completed, 1);
    assert_eq!(disputed, 0);
    assert_eq!(volume, 500);
    assert_eq!(counterparties, 1);
    assert_eq!(last_ledger, 10);
}

#[test]
fn verify_and_aggregate_rejects_a_tampered_leaf() {
    let env = Env::default();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);
    let leaf = make_leaf(&env, &seller, &buyer, 500, mst::STATUS_RELEASED, 10);
    let (root, mut proof) = single_leaf_proof(&env, &leaf, 3);

    // Tamper with the disclosed amount after the proof was built against
    // the real root — a single altered field must sink the whole leaf,
    // not just under-report its amount (issue #387 acceptance criterion).
    let original = proof.proofs.get(0).unwrap();
    let mut tampered_leaf = original.leaf.clone();
    tampered_leaf.amount = 999_999;
    proof.proofs.set(
        0,
        LeafProof {
            leaf: tampered_leaf,
            leaf_index: original.leaf_index,
            siblings: original.siblings.clone(),
        },
    );

    let (total, completed, _disputed, volume, _counterparties, _last_ledger) =
        verify_and_aggregate(&env, &proof, &root, &seller);

    assert_eq!(total, 0, "a tampered leaf must not be counted at all");
    assert_eq!(completed, 0);
    assert_eq!(volume, 0);
}

#[test]
fn verify_and_aggregate_excludes_self_trades() {
    let env = Env::default();
    let addr = Address::generate(&env);
    let leaf = make_leaf(&env, &addr, &addr, 1_000, mst::STATUS_RELEASED, 5);
    let (root, proof) = single_leaf_proof(&env, &leaf, 1);

    let (total, completed, _disputed, volume, _counterparties, _last_ledger) =
        verify_and_aggregate(&env, &proof, &root, &addr);

    assert_eq!(total, 0, "self-trades must be excluded from scoring");
    assert_eq!(completed, 0);
    assert_eq!(volume, 0);
}

#[test]
fn verify_and_aggregate_dedupes_a_counterparty_seen_in_both_roles() {
    let env = Env::default();
    let addr = Address::generate(&env);
    let other = Address::generate(&env);

    // `addr` is seller in one trade and buyer in another, both against the
    // same real-world counterparty `other`.
    let leaf_a = make_leaf(&env, &addr, &other, 100, mst::STATUS_RELEASED, 1);
    let leaf_b = make_leaf(&env, &other, &addr, 200, mst::STATUS_RELEASED, 2);

    // Put both leaves in the same tree, at indices 0 and 1 (siblings of
    // each other), so a single `ScoreProof` batch can carry both proofs
    // against one shared root.
    let node_a = mst::leaf_node(&env, &leaf_a);
    let node_b = mst::leaf_node(&env, &leaf_b);
    // Depth 0 -> 1: the one real combine of the two leaves. Every level
    // above that combines with a zero sibling (both leaves' index becomes
    // 0 — i.e. "left" — after this step), matching the all-zero padding
    // used in `siblings_for_a` / `siblings_for_b` below. Replicate that
    // here to get the *actual* depth-`MST_DEPTH` root, not just the
    // depth-1 value.
    let mut root_node = mst::combine(&env, &node_a, &node_b);
    for _ in 1..mst::MST_DEPTH {
        root_node = mst::combine(&env, &root_node, &mst::zero_node(&env));
    }
    let root = root_node.0.clone();

    let mut siblings_for_a = Vec::new(&env);
    siblings_for_a.push_back(MstSibling {
        hash: node_b.0.clone(),
        sum: node_b.1,
    });
    for _ in 1..mst::MST_DEPTH {
        siblings_for_a.push_back(MstSibling {
            hash: BytesN::from_array(&env, &[0u8; 32]),
            sum: 0,
        });
    }
    let mut siblings_for_b = Vec::new(&env);
    siblings_for_b.push_back(MstSibling {
        hash: node_a.0.clone(),
        sum: node_a.1,
    });
    for _ in 1..mst::MST_DEPTH {
        siblings_for_b.push_back(MstSibling {
            hash: BytesN::from_array(&env, &[0u8; 32]),
            sum: 0,
        });
    }

    let mut proofs = Vec::new(&env);
    proofs.push_back(LeafProof {
        leaf: leaf_a,
        leaf_index: 0,
        siblings: siblings_for_a,
    });
    proofs.push_back(LeafProof {
        leaf: leaf_b,
        leaf_index: 1,
        siblings: siblings_for_b,
    });

    let (total, _completed, _disputed, _volume, counterparties, _last_ledger) =
        verify_and_aggregate(&env, &ScoreProof { proofs }, &root, &addr);

    assert_eq!(total, 2);
    assert_eq!(
        counterparties, 1,
        "the same real-world counterparty in two different roles must dedupe to one"
    );
}

#[test]
fn randomized_insertion_and_verification_across_many_trades() {
    // Deterministic xorshift32 PRNG (no external crate) exercising
    // "randomized insertion ... verification" (issue #387) end-to-end
    // through the mock escrow + reputation contract.
    let (env, admin, escrow) = setup_env();
    let mut state: u32 = 0xC0FFEE;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state
    };

    let seller = Address::generate(&env);
    let statuses = [
        TradeStatus::Released,
        TradeStatus::Refunded,
        TradeStatus::Disputed,
        TradeStatus::Resolved,
    ];

    let mut trades: std::vec::Vec<(Address, Address, TradeStatus)> = std::vec::Vec::new();
    for _ in 0..40 {
        let buyer = Address::generate(&env);
        let status = statuses[(next() % statuses.len() as u32) as usize].clone();
        trades.push((seller.clone(), buyer, status));
    }

    setup_escrow_trades(&env, &escrow, &trades);
    let client = setup_contract(&env, &admin, &escrow);

    let score = client.compute_score(&seller);
    let breakdown = client.get_score_breakdown(&seller);
    assert_eq!(breakdown.score, score);
    assert!(breakdown.total_trades > 0);
    assert!(score <= 1000);
}

#[test]
fn compute_score_incremental_matches_full_recompute_after_new_trades() {
    let (env, admin, escrow) = setup_env();
    let seller = Address::generate(&env);
    let buyer1 = Address::generate(&env);
    let buyer2 = Address::generate(&env);

    setup_escrow_trades(
        &env,
        &escrow,
        &[(seller.clone(), buyer1.clone(), TradeStatus::Released)],
    );
    let client = setup_contract(&env, &admin, &escrow);

    let first = client.compute_score_incremental(&seller);
    assert!(first > 0);

    // A second trade arrives later. `setup_escrow_trades` always indexes
    // from 1, so re-supplying the full trade list (not just the delta)
    // rewrites index 1 identically and appends index 2 — there's no
    // "append one more" helper, so this is the correct way to grow the
    // fixture without disturbing already-written indices.
    let mut combined: std::vec::Vec<(Address, Address, TradeStatus)> = std::vec::Vec::new();
    combined.push((seller.clone(), buyer1, TradeStatus::Released));
    combined.push((seller.clone(), buyer2, TradeStatus::Released));
    setup_escrow_trades(&env, &escrow, &combined);

    let second_incremental = client.compute_score_incremental(&seller);
    let full = client.compute_score(&seller);
    assert_eq!(
        second_incremental, full,
        "incremental score must match a full recompute over the same trades"
    );
    assert!(second_incremental >= first);
}
