//! Issue #387 acceptance criterion: `compute_score`'s local verification
//! and aggregation work — `verify_and_aggregate` — must execute in under
//! 500,000 CPU instructions for 10,000 trades.
//!
//! Building a full 10,000-leaf tree and its proofs happens *before* the
//! measured section: this benchmark isolates the cost this issue actually
//! re-architects (replacing an O(n) cross-contract `get_trade_by_index` +
//! `get_trade` scan with local O(log n)-per-leaf proof verification).
//! Escrow's own incremental `update_reputation_root` and
//! `get_reputation_proof` costs are a separate concern belonging to the
//! escrow crate's own tests, not this one — there is no on-chain-realistic
//! way to measure real cross-contract WASM instruction cost from a plain
//! `cargo test` run without a deployed testnet contract, which is out of
//! reach in this environment.
use super::*;
use soroban_sdk::testutils::Address as _;

extern crate std;

/// Builds a full `mst::MAX_LEAVES`-wide tree from `count` synthetic trades
/// (alternating `Released`/`Disputed` so the benchmark also exercises the
/// dispute-penalty branch of the scoring formula), returning the root and
/// every non-empty leaf's proof.
fn build_benchmark_tree(env: &Env, seller: &Address, count: u32) -> (BytesN<32>, std::vec::Vec<mst::LeafProof>) {
    let total_slots = mst::MAX_LEAVES as usize;
    let mut level0: std::vec::Vec<(BytesN<32>, i128)> = std::vec::Vec::with_capacity(total_slots);
    let mut leaves: std::vec::Vec<Option<mst::ReputationLeaf>> = std::vec::Vec::with_capacity(total_slots);

    for slot in 0..total_slots {
        let idx = slot as u32;
        if idx == 0 || idx > count {
            level0.push(mst::zero_node(env));
            leaves.push(None);
            continue;
        }

        let buyer = Address::generate(env);
        let mut id_bytes = [0u8; 32];
        id_bytes[0..4].copy_from_slice(&idx.to_be_bytes());
        let status_bits = if idx % 5 == 0 {
            mst::STATUS_DISPUTED
        } else {
            mst::STATUS_RELEASED
        };
        let leaf = mst::ReputationLeaf {
            trade_id_hash: BytesN::from_array(env, &id_bytes),
            amount: 1_000_000,
            status_bits,
            counterparty_hash: mst::counterparty_hash(env, seller, &buyer),
            ledger: idx,
        };
        level0.push(mst::leaf_node(env, &leaf));
        leaves.push(Some(leaf));
    }

    let mut levels: std::vec::Vec<std::vec::Vec<(BytesN<32>, i128)>> = std::vec::Vec::new();
    levels.push(level0);
    for _ in 0..mst::MST_DEPTH {
        let cur = levels.last().unwrap();
        let mut next: std::vec::Vec<(BytesN<32>, i128)> = std::vec::Vec::with_capacity(cur.len() / 2);
        let mut i = 0;
        while i < cur.len() {
            next.push(mst::combine(env, &cur[i], &cur[i + 1]));
            i += 2;
        }
        levels.push(next);
    }
    let root = levels[mst::MST_DEPTH as usize][0].0.clone();

    let mut proofs: std::vec::Vec<mst::LeafProof> = std::vec::Vec::new();
    for (slot, leaf_opt) in leaves.iter().enumerate() {
        let Some(leaf) = leaf_opt else { continue };
        let mut siblings = Vec::new(env);
        let mut index = slot as u32;
        for depth in 0..mst::MST_DEPTH {
            let sib = levels[depth as usize][(index ^ 1) as usize].clone();
            siblings.push_back(mst::MstSibling {
                hash: sib.0,
                sum: sib.1,
            });
            index /= 2;
        }
        proofs.push(mst::LeafProof {
            leaf: leaf.clone(),
            leaf_index: slot as u32,
            siblings,
        });
    }

    (root, proofs)
}

#[test]
fn verify_and_aggregate_stays_under_500k_instructions_for_10000_trades() {
    let env = Env::default();
    env.budget().reset_unlimited();
    let seller = Address::generate(&env);

    let (root, proof_vec) = build_benchmark_tree(&env, &seller, MAX_TRADES);
    let mut proofs = Vec::new(&env);
    for p in proof_vec {
        proofs.push_back(p);
    }
    let score_proof = ScoreProof { proofs };

    // Only the verification/aggregation call below is measured — tree and
    // proof construction above is fixture setup, not part of what the
    // issue's acceptance criterion bounds.
    env.budget().reset_default();
    let (total, _completed, _disputed, _volume, _counterparties, _last_ledger) =
        verify_and_aggregate(&env, &score_proof, &root, &seller);
    let instructions = env.budget().cpu_instruction_cost();

    std::println!(
        "verify_and_aggregate CPU instructions for {} trades: {}",
        MAX_TRADES,
        instructions
    );
    assert_eq!(total, MAX_TRADES, "every constructed leaf should verify and count");
    assert!(
        instructions < 500_000,
        "verify_and_aggregate used {} CPU instructions for {} trades, expected < 500,000 (issue #387)",
        instructions,
        MAX_TRADES
    );
}
