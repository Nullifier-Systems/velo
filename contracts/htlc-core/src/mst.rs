//! Reputation Merkle-sum tree (MST) primitives shared by `escrow` (which
//! maintains the tree) and `reputation` (which verifies proofs against it).
//!
//! Design (issue #387): trades are appended to the tree in the same
//! sequential order `escrow` already assigns them via `TradeCounter` /
//! `TradeId`, so a trade's MST leaf index is simply its existing sequential
//! index — no separate insertion bookkeeping is needed. A leaf is written
//! once, when a trade first reaches a terminal state (Released / Refunded /
//! Resolved); `Locked` / `Disputed` trades have no leaf yet.
//!
//! Every node (leaf or internal) carries a `(hash, sum)` pair. The hash
//! commits to both children's hashes *and* their combined sum, so altering
//! any leaf field — including `amount` — changes every ancestor hash up to
//! the root. This is what makes the tree a Merkle-**sum** tree rather than a
//! plain Merkle tree: sums stay verifiable alongside leaf integrity, which
//! matters because the reputation score is additive over trade amounts.
//!
//! Proof verification here only concerns itself with *membership* of a
//! disclosed leaf (the reputation contract needs each trade's real fields to
//! run its scoring formula — there is no ZK/non-disclosure requirement for
//! this issue). Empty subtrees therefore default to a plain zero hash/sum
//! rather than distinct precomputed per-depth "empty" hashes: that
//! distinction only matters for non-membership proofs, which nothing here
//! constructs or checks.
#![allow(dead_code)]

use crate::TradeStatus;
use soroban_sdk::{contracttype, xdr::ToXdr, Address, BytesN, Env, Vec};

/// Tree depth. 2^14 = 16,384 leaf slots, comfortably above the raised
/// `MAX_TRADES` of 10,000 (issue #387 thresholds) with headroom to grow.
pub const MST_DEPTH: u32 = 14;

/// Maximum number of leaves representable at [`MST_DEPTH`].
pub const MAX_LEAVES: u32 = 1 << MST_DEPTH;

// ---------------------------------------------------------------------------
// Status encoding shared between the escrow writer and reputation reader.
// ---------------------------------------------------------------------------

pub const STATUS_LOCKED: u32 = 0;
pub const STATUS_RELEASED: u32 = 1;
pub const STATUS_REFUNDED: u32 = 2;
pub const STATUS_DISPUTED: u32 = 3;
pub const STATUS_RESOLVED: u32 = 4;

/// Encodes a `TradeStatus` as the `status_bits` stored in a [`ReputationLeaf`].
/// Kept in one place so escrow (writer) and reputation (reader) can never
/// drift apart on the mapping.
pub fn status_bits(status: TradeStatus) -> u32 {
    match status {
        TradeStatus::Locked => STATUS_LOCKED,
        TradeStatus::Released => STATUS_RELEASED,
        TradeStatus::Refunded => STATUS_REFUNDED,
        TradeStatus::Disputed => STATUS_DISPUTED,
        TradeStatus::Resolved => STATUS_RESOLVED,
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// One MST leaf: a single trade's terminal-state snapshot.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationLeaf {
    pub trade_id_hash: BytesN<32>,
    pub amount: i128,
    pub status_bits: u32,
    /// Order-independent commitment to the trade's two parties — see
    /// [`counterparty_hash`] — so an address's completed trades dedupe to
    /// the same counterparty regardless of which side (buyer/seller) it
    /// played in each trade.
    pub counterparty_hash: BytesN<32>,
    pub ledger: u32,
}

/// A sibling node encountered while walking a leaf's path to the root.
/// Carries both `hash` and `sum` because this is a Merkle-*sum* tree: the
/// sum must be folded back in at every level to reproduce the committed
/// hash, not just concatenated hashes.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MstSibling {
    pub hash: BytesN<32>,
    pub sum: i128,
}

/// Membership proof for one leaf: the leaf itself plus every sibling from
/// the leaf's level up to (but not including) the root, bottom-up.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeafProof {
    pub leaf: ReputationLeaf,
    pub leaf_index: u32,
    pub siblings: Vec<MstSibling>,
}

/// A batch of [`LeafProof`]s — one per terminal-state trade belonging to the
/// address a caller asked `get_reputation_proof` about. The reputation
/// contract verifies each proof independently against the single global
/// `ReputationRoot` and derives its own score components from whichever
/// leaves survive verification; it never trusts caller-supplied aggregates.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScoreProof {
    pub proofs: Vec<LeafProof>,
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/// The default value of any MST slot that has never been written — see the
/// module doc for why a plain zero is sufficient here.
pub fn zero_node(env: &Env) -> (BytesN<32>, i128) {
    (BytesN::from_array(env, &[0u8; 32]), 0)
}

/// Order-independent commitment to a trade's two parties: hashes each
/// address individually, sorts the two resulting digests, then hashes the
/// pair. This way an address's counterparty is recognized as the same
/// counterparty whether that address was the buyer in one trade and the
/// seller in another — a plain `H(seller || buyer)` would count the same
/// real-world counterparty twice across such role-swapped trades.
pub fn counterparty_hash(env: &Env, seller: &Address, buyer: &Address) -> BytesN<32> {
    let seller_h = env.crypto().sha256(&seller.clone().to_xdr(env)).to_bytes();
    let buyer_h = env.crypto().sha256(&buyer.clone().to_xdr(env)).to_bytes();
    // BytesN<32> orders lexicographically by its underlying bytes, giving a
    // stable, role-independent ordering of the two participants.
    let (a, b) = if seller_h <= buyer_h {
        (seller_h, buyer_h)
    } else {
        (buyer_h, seller_h)
    };
    env.crypto().sha256(&(a, b).to_xdr(env)).to_bytes()
}

/// Leaf node value: `(hash, sum)`. `sum` is just the leaf's own amount;
/// `hash` commits to every field, so tampering with any of them — including
/// `amount` — is caught the moment the path is recomputed.
pub fn leaf_node(env: &Env, leaf: &ReputationLeaf) -> (BytesN<32>, i128) {
    let hash = env.crypto().sha256(&leaf.clone().to_xdr(env)).to_bytes();
    (hash, leaf.amount)
}

/// Combines two child nodes into their parent `(hash, sum)`. The sum is
/// folded into the hash preimage, so a forged sum (without the matching
/// children) recomputes to a different hash than the one actually stored.
pub fn combine(env: &Env, left: &(BytesN<32>, i128), right: &(BytesN<32>, i128)) -> (BytesN<32>, i128) {
    let sum = left.1.saturating_add(right.1);
    let hash = env
        .crypto()
        .sha256(&(left.0.clone(), right.0.clone(), sum).to_xdr(env))
        .to_bytes();
    (hash, sum)
}

/// Recomputes the root `(hash, sum)` implied by `leaf` at `leaf_index`
/// together with `siblings`, walking bottom-up. Returns `None` for a
/// structurally malformed proof (wrong sibling count) rather than panicking,
/// so callers can simply skip an invalid proof instead of aborting the
/// whole batch.
pub fn recompute_root(
    env: &Env,
    leaf: &ReputationLeaf,
    leaf_index: u32,
    siblings: &Vec<MstSibling>,
) -> Option<(BytesN<32>, i128)> {
    if siblings.len() != MST_DEPTH {
        return None;
    }

    let mut node = leaf_node(env, leaf);
    let mut index = leaf_index;
    for sibling in siblings.iter() {
        let sib = (sibling.hash.clone(), sibling.sum);
        node = if index % 2 == 0 {
            combine(env, &node, &sib)
        } else {
            combine(env, &sib, &node)
        };
        index /= 2;
    }
    Some(node)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn sample_leaf(env: &Env, amount: i128, status: u32, ledger: u32) -> ReputationLeaf {
        let seller = Address::generate(env);
        let buyer = Address::generate(env);
        ReputationLeaf {
            trade_id_hash: BytesN::from_array(env, &[7u8; 32]),
            amount,
            status_bits: status,
            counterparty_hash: counterparty_hash(env, &seller, &buyer),
            ledger,
        }
    }

    /// Builds a full-height path of default (zero) siblings — equivalent to
    /// a tree containing only this one leaf — and returns the resulting
    /// root, for tests that don't care about other leaves.
    fn lone_leaf_root(env: &Env, leaf: &ReputationLeaf, leaf_index: u32) -> ((BytesN<32>, i128), Vec<MstSibling>) {
        let mut siblings = Vec::new(env);
        for _ in 0..MST_DEPTH {
            let (h, s) = zero_node(env);
            siblings.push_back(MstSibling { hash: h, sum: s });
        }
        let root = recompute_root(env, leaf, leaf_index, &siblings).unwrap();
        (root, siblings)
    }

    #[test]
    fn counterparty_hash_is_symmetric_across_roles() {
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);

        // a as seller with b as buyer, and a as buyer with b as seller,
        // must dedupe to the same counterparty commitment.
        assert_eq!(counterparty_hash(&env, &a, &b), counterparty_hash(&env, &b, &a));
    }

    #[test]
    fn valid_proof_recomputes_to_the_stored_root() {
        let env = Env::default();
        let leaf = sample_leaf(&env, 100, STATUS_RELEASED, 42);
        let (root, siblings) = lone_leaf_root(&env, &leaf, 5);

        let recomputed = recompute_root(&env, &leaf, 5, &siblings).unwrap();
        assert_eq!(recomputed, root);
    }

    #[test]
    fn tampered_amount_fails_verification() {
        let env = Env::default();
        let leaf = sample_leaf(&env, 100, STATUS_RELEASED, 42);
        let (root, siblings) = lone_leaf_root(&env, &leaf, 5);

        let mut tampered = leaf.clone();
        tampered.amount = 1_000_000;
        let recomputed = recompute_root(&env, &tampered, 5, &siblings).unwrap();
        assert_ne!(recomputed, root);
    }

    #[test]
    fn tampered_status_fails_verification() {
        let env = Env::default();
        let leaf = sample_leaf(&env, 100, STATUS_RELEASED, 42);
        let (root, siblings) = lone_leaf_root(&env, &leaf, 5);

        let mut tampered = leaf.clone();
        tampered.status_bits = STATUS_RESOLVED;
        let recomputed = recompute_root(&env, &tampered, 5, &siblings).unwrap();
        assert_ne!(recomputed, root);
    }

    #[test]
    fn wrong_leaf_index_fails_verification() {
        let env = Env::default();
        let leaf = sample_leaf(&env, 100, STATUS_RELEASED, 42);
        let (root, siblings) = lone_leaf_root(&env, &leaf, 5);

        // Same leaf and siblings, but claimed at a different index — parity
        // along the path differs, so the recomputed root differs too.
        let recomputed = recompute_root(&env, &leaf, 6, &siblings).unwrap();
        assert_ne!(recomputed, root);
    }

    #[test]
    fn malformed_proof_sibling_count_is_rejected() {
        let env = Env::default();
        let leaf = sample_leaf(&env, 100, STATUS_RELEASED, 42);
        let mut siblings = Vec::new(&env);
        siblings.push_back(MstSibling {
            hash: BytesN::from_array(&env, &[0u8; 32]),
            sum: 0,
        });
        assert!(recompute_root(&env, &leaf, 5, &siblings).is_none());
    }

    #[test]
    fn two_leaves_combine_to_a_consistent_shared_root() {
        let env = Env::default();
        let leaf_a = sample_leaf(&env, 100, STATUS_RELEASED, 10);
        let leaf_b = sample_leaf(&env, 250, STATUS_REFUNDED, 20);

        // Build a two-leaf tree by hand at indices 0 and 1 (siblings of
        // each other at depth 0), zero above that.
        let node_a = leaf_node(&env, &leaf_a);
        let node_b = leaf_node(&env, &leaf_b);
        let parent = combine(&env, &node_a, &node_b);
        assert_eq!(parent.1, 350); // sums fold correctly

        let mut siblings_for_a = Vec::new(&env);
        siblings_for_a.push_back(MstSibling {
            hash: node_b.0.clone(),
            sum: node_b.1,
        });
        for _ in 1..MST_DEPTH {
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
        for _ in 1..MST_DEPTH {
            siblings_for_b.push_back(MstSibling {
                hash: BytesN::from_array(&env, &[0u8; 32]),
                sum: 0,
            });
        }

        let root_via_a = recompute_root(&env, &leaf_a, 0, &siblings_for_a).unwrap();
        let root_via_b = recompute_root(&env, &leaf_b, 1, &siblings_for_b).unwrap();
        assert_eq!(root_via_a, root_via_b);
    }

    #[test]
    fn randomized_tamper_always_detected() {
        // Deterministic xorshift32 PRNG — no external crate — exercising
        // "randomized ... verification" (issue #387) without adding a new
        // test-framework dependency.
        let env = Env::default();
        let mut state: u32 = 0x9E3779B9;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state
        };

        for _ in 0..50 {
            let amount = (next() % 1_000_000) as i128;
            let status = next() % 5;
            let ledger = next();
            let leaf = sample_leaf(&env, amount, status, ledger);
            let index = next() % MAX_LEAVES;
            let (root, siblings) = lone_leaf_root(&env, &leaf, index);

            // Unmodified proof must verify.
            assert_eq!(recompute_root(&env, &leaf, index, &siblings).unwrap(), root);

            // Flipping exactly one field must break verification.
            let mut tampered = leaf.clone();
            match next() % 3 {
                0 => tampered.amount = tampered.amount.saturating_add(1),
                1 => tampered.status_bits = (tampered.status_bits + 1) % 5,
                _ => tampered.ledger = tampered.ledger.wrapping_add(1),
            }
            assert_ne!(recompute_root(&env, &tampered, index, &siblings).unwrap(), root);
        }
    }
}
