//! Incremental Merkle Tree implementation for ZK credential registry.

use soroban_sdk::{contracttype, Bytes, BytesN, Env, Vec};
use crate::DataKey;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreeConfig {
    pub max_leaves: u32,
    pub depth: u32,
    pub next_index: u32,
}

pub struct IncrementalMerkleTree;

impl IncrementalMerkleTree {
    /// Precomputes zero hashes for levels 0..=depth.
    pub fn zero_hashes(env: &Env, depth: u32) -> Vec<BytesN<32>> {
        let mut zeros = Vec::new(env);
        let mut curr = BytesN::from_array(env, &[0u8; 32]);
        zeros.push_back(curr.clone());
        for _ in 0..depth {
            curr = Self::hash_pair(env, &curr, &curr);
            zeros.push_back(curr.clone());
        }
        zeros
    }

    /// Computes a single zero hash at a given level.
    pub fn zero_hash(env: &Env, level: u32) -> BytesN<32> {
        let mut curr = BytesN::from_array(env, &[0u8; 32]);
        for _ in 0..level {
            curr = Self::hash_pair(env, &curr, &curr);
        }
        curr
    }

    /// Helper for SHA-256 node pair hashing.
    pub fn hash_pair(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
        let mut input = Bytes::new(env);
        input.append(&left.clone().into());
        input.append(&right.clone().into());
        env.crypto().sha256(&input).into()
    }

    /// Appends a leaf commitment to the incremental Merkle tree and updates filled subtrees / node storage.
    /// Returns (inserted_index, new_merkle_root).
    pub fn append(env: &Env, config: &mut TreeConfig, leaf: &BytesN<32>) -> (u32, BytesN<32>) {
        let index = config.next_index;

        // Store leaf commitment sparsely
        env.storage().persistent().set(&DataKey::Leaf(index), leaf);

        let mut curr_zero = BytesN::from_array(env, &[0u8; 32]);
        let mut curr_hash = leaf.clone();
        let mut curr_idx = index;

        for level in 0..config.depth {
            // Persist node at (level, curr_idx)
            env.storage()
                .persistent()
                .set(&DataKey::Node(level, curr_idx), &curr_hash);

            if curr_idx % 2 == 0 {
                // Left child
                env.storage()
                    .persistent()
                    .set(&DataKey::SubTree(level), &curr_hash);
                curr_hash = Self::hash_pair(env, &curr_hash, &curr_zero);
            } else {
                // Right child
                let left: BytesN<32> = env
                    .storage()
                    .persistent()
                    .get(&DataKey::SubTree(level))
                    .unwrap_or_else(|| curr_zero.clone());
                curr_hash = Self::hash_pair(env, &left, &curr_hash);
            }
            curr_idx /= 2;
            curr_zero = Self::hash_pair(env, &curr_zero, &curr_zero);
        }

        // Store root at (depth, 0)
        env.storage()
            .persistent()
            .set(&DataKey::Node(config.depth, 0), &curr_hash);

        config.next_index += 1;
        (index, curr_hash)
    }

    /// Calculates initial empty root for a tree of given depth.
    pub fn empty_root(env: &Env, depth: u32) -> BytesN<32> {
        Self::zero_hash(env, depth)
    }

    /// Returns the Merkle path (sibling hashes from level 0 to depth-1) for a given leaf index.
    pub fn get_merkle_path(env: &Env, index: u32, depth: u32) -> Vec<BytesN<32>> {
        let zeros = Self::zero_hashes(env, depth);
        let mut path = Vec::new(env);

        for level in 0..depth {
            let sibling_idx = (index >> level) ^ 1;
            let sibling_hash: BytesN<32> = env
                .storage()
                .persistent()
                .get(&DataKey::Node(level, sibling_idx))
                .unwrap_or_else(|| zeros.get(level).unwrap());
            path.push_back(sibling_hash);
        }

        path
    }
}
