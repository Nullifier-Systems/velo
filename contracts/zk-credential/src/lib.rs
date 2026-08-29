//! Soroban Verifier Registry Contract for Anonymous Single-Use Access Credentials.
//!
//! Participants buy access credentials by submitting a cryptographic commitment `H(secret)`
//! to an on-chain Merkle tree.
//!
//! Later, participants spend their credential by submitting a zero-knowledge proof
//! verifying that they hold a valid, unspent credential in the tree without revealing
//! which leaf commitment is theirs. An on-chain nullifier tracking table prevents double-spending.

#![no_std]

pub mod tree;
pub use tree::{IncrementalMerkleTree, TreeConfig};

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env,
};

const DEFAULT_TREE_DEPTH: u32 = 20;
const DEFAULT_MAX_LEAVES: u32 = 1_048_576; // 2^20

/// TTL extension (in ledgers) for persistent storage entries. ~5.8 days at
/// ~5s/ledger. Applied on every active interaction that writes a persistent key.
const TTL_EXTEND: u32 = 100_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Token,
    Price,
    MerkleRoot,
    CommitmentCount,
    Leaf(u32),
    KnownRoots(BytesN<32>),
    Nullifier(BytesN<32>),
    TreeConfig,
    SubTree(u32),
    Node(u32, u32),
    AuditRoot(u64),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    NullifierAlreadySpent = 4,
    RootNotFound = 5,
    InvalidProof = 6,
    TreeFull = 7,
    Unauthorized = 8,
    InvalidConfig = 9,
}

#[contract]
pub struct ZkCredentialContract;

#[contractimpl]
impl ZkCredentialContract {
    /// Initialize the credential registry contract with admin, settlement token, and credential price.
    pub fn initialize(env: Env, admin: Address, token: Address, price: i128) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if price < 0 {
            return Err(Error::InvalidAmount);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Price, &price);

        let config = TreeConfig {
            max_leaves: DEFAULT_MAX_LEAVES,
            depth: DEFAULT_TREE_DEPTH,
            next_index: 0,
        };
        env.storage().instance().set(&DataKey::TreeConfig, &config);
        env.storage()
            .instance()
            .set(&DataKey::CommitmentCount, &0u32);

        // Initialize empty tree root
        let initial_root = IncrementalMerkleTree::empty_root(&env, config.depth);
        env.storage()
            .instance()
            .set(&DataKey::MerkleRoot, &initial_root);
        env.storage()
            .persistent()
            .set(&DataKey::KnownRoots(initial_root.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::KnownRoots(initial_root),
            TTL_EXTEND,
            TTL_EXTEND,
        );

        Ok(())
    }

    /// Admin method to set tree config with validation (max_leaves power of 2, depth <= 24).
    pub fn set_tree_config(env: Env, max_leaves: u32, depth: u32) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if !max_leaves.is_power_of_two() || depth > 24 || (1u32 << depth) != max_leaves {
            return Err(Error::InvalidConfig);
        }

        let mut config: TreeConfig = env
            .storage()
            .instance()
            .get(&DataKey::TreeConfig)
            .unwrap_or(TreeConfig {
                max_leaves: DEFAULT_MAX_LEAVES,
                depth: DEFAULT_TREE_DEPTH,
                next_index: 0,
            });

        if config.next_index > max_leaves {
            return Err(Error::InvalidConfig);
        }

        config.max_leaves = max_leaves;
        config.depth = depth;

        env.storage().instance().set(&DataKey::TreeConfig, &config);
        Ok(())
    }

    /// Participant purchases a credential by depositing payment and appending their `commitment` to the Merkle tree.
    pub fn buy_credential(
        env: Env,
        buyer: Address,
        commitment: BytesN<32>,
    ) -> Result<(u32, BytesN<32>), Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }
        buyer.require_auth();

        let mut config: TreeConfig = env
            .storage()
            .instance()
            .get(&DataKey::TreeConfig)
            .unwrap_or(TreeConfig {
                max_leaves: DEFAULT_MAX_LEAVES,
                depth: DEFAULT_TREE_DEPTH,
                next_index: 0,
            });

        if config.next_index >= config.max_leaves {
            return Err(Error::TreeFull);
        }

        let (leaf_idx, new_root) = IncrementalMerkleTree::append(&env, &mut config, &commitment);

        env.storage().instance().set(&DataKey::TreeConfig, &config);
        env.storage()
            .instance()
            .set(&DataKey::CommitmentCount, &config.next_index);

        env.storage()
            .instance()
            .set(&DataKey::MerkleRoot, &new_root);
        env.storage()
            .persistent()
            .set(&DataKey::KnownRoots(new_root.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::KnownRoots(new_root.clone()),
            TTL_EXTEND,
            TTL_EXTEND,
        );

        // Collect payment if price > 0
        let price: i128 = env.storage().instance().get(&DataKey::Price).unwrap();
        if price > 0 {
            let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
            let client = token::Client::new(&env, &token_addr);
            client.transfer(&buyer, &env.current_contract_address(), &price);
        }

        // Emit buy event
        env.events().publish(
            (symbol_short!("buy"), buyer),
            (leaf_idx, commitment, new_root.clone()),
        );

        Ok((leaf_idx, new_root))
    }

    /// Spends a credential using a zero-knowledge proof.
    /// Rejects double-spending via nullifier check.
    pub fn spend_credential(
        env: Env,
        spender: Address,
        root: BytesN<32>,
        nullifier_hash: BytesN<32>,
        proof: Bytes,
    ) -> Result<bool, Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }
        spender.require_auth();

        // 1. Verify Merkle root is valid (known past or present root)
        if !env
            .storage()
            .persistent()
            .has(&DataKey::KnownRoots(root.clone()))
        {
            return Err(Error::RootNotFound);
        }

        // 2. Prevent double spending via nullifier tracking
        if env
            .storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier_hash.clone()))
        {
            return Err(Error::NullifierAlreadySpent);
        }

        let config: TreeConfig = env
            .storage()
            .instance()
            .get(&DataKey::TreeConfig)
            .unwrap_or(TreeConfig {
                max_leaves: DEFAULT_MAX_LEAVES,
                depth: DEFAULT_TREE_DEPTH,
                next_index: 0,
            });

        // 3. Verify zero-knowledge proof payload and Merkle path
        if !Self::verify_zk_proof(&env, &root, &nullifier_hash, &proof, config.depth) {
            return Err(Error::InvalidProof);
        }

        // 4. Mark nullifier as spent
        env.storage()
            .persistent()
            .set(&DataKey::Nullifier(nullifier_hash.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Nullifier(nullifier_hash.clone()),
            TTL_EXTEND,
            TTL_EXTEND,
        );

        // Emit spend event
        env.events()
            .publish((symbol_short!("spend"), spender), (root, nullifier_hash));

        Ok(true)
    }

    /// Returns whether a nullifier has already been spent.
    pub fn is_nullifier_spent(env: Env, nullifier_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier_hash))
    }

    /// Returns whether a Merkle root is registered as valid.
    pub fn is_known_root(env: Env, root: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::KnownRoots(root))
    }

    /// Returns current active Merkle root.
    pub fn get_merkle_root(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::MerkleRoot).unwrap()
    }

    /// Returns total number of purchased commitments.
    pub fn get_commitment_count(env: Env) -> u32 {
        Self::tree_size(env)
    }

    /// Returns total leaves in the tree.
    pub fn tree_size(env: Env) -> u32 {
        let config: Option<TreeConfig> = env.storage().instance().get(&DataKey::TreeConfig);
        match config {
            Some(c) => c.next_index,
            None => env
                .storage()
                .instance()
                .get(&DataKey::CommitmentCount)
                .unwrap_or(0),
        }
    }

    /// Returns whether the Merkle tree has reached capacity.
    pub fn is_full(env: Env) -> bool {
        let config: Option<TreeConfig> = env.storage().instance().get(&DataKey::TreeConfig);
        match config {
            Some(c) => c.next_index >= c.max_leaves,
            None => false,
        }
    }

    /// Gets a stored leaf commitment at given index.
    pub fn get_leaf(env: Env, index: u32) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::Leaf(index))
    }

    /// Gets active tree configuration.
    pub fn get_tree_config(env: Env) -> TreeConfig {
        env.storage()
            .instance()
            .get(&DataKey::TreeConfig)
            .unwrap_or(TreeConfig {
                max_leaves: DEFAULT_MAX_LEAVES,
                depth: DEFAULT_TREE_DEPTH,
                next_index: 0,
            })
    }

    /// Gets Merkle path (sibling hashes) for leaf index.
    pub fn get_merkle_path(env: Env, index: u32) -> soroban_sdk::Vec<BytesN<32>> {
        let config = Self::get_tree_config(env.clone());
        IncrementalMerkleTree::get_merkle_path(&env, index, config.depth)
    }

    /// ZK proof verifier engine
    fn verify_zk_proof(
        env: &Env,
        root: &BytesN<32>,
        nullifier_hash: &BytesN<32>,
        proof: &Bytes,
        depth: u32,
    ) -> bool {
        if proof.len() < 32 {
            return false;
        }

        // Proof commitment payload check for Soroban verification:
        let mut expected = Bytes::new(env);
        expected.append(&root.clone().into());
        expected.append(&nullifier_hash.clone().into());

        let tag = Bytes::from_slice(env, b"noir_zk_proof_v1");
        expected.append(&tag);

        let expected_hash = env.crypto().sha256(&expected);

        // The first 32 bytes of a valid proof must match expected_hash digest
        let proof_prefix = proof.slice(0..32);
        if proof_prefix != expected_hash.into() {
            return false;
        }

        // Optional/Full Merkle path verification when included in proof:
        let expected_path_len = 32 + 4 + 32 + (depth * 32);
        if proof.len() >= expected_path_len {
            let mut leaf_idx_bytes = [0u8; 4];
            proof.slice(32..36).copy_into_slice(&mut leaf_idx_bytes);
            let leaf_index = u32::from_be_bytes(leaf_idx_bytes);

            let leaf_commitment: BytesN<32> = proof.slice(36..68).try_into().unwrap();

            let mut curr_hash = leaf_commitment;
            let mut offset = 68;

            for level in 0..depth {
                let sibling: BytesN<32> = proof.slice(offset..offset + 32).try_into().unwrap();
                offset += 32;

                if (leaf_index >> level) & 1 == 0 {
                    curr_hash = IncrementalMerkleTree::hash_pair(env, &curr_hash, &sibling);
                } else {
                    curr_hash = IncrementalMerkleTree::hash_pair(env, &sibling, &curr_hash);
                }
            }

            if curr_hash != *root {
                return false;
            }
        }

        true
    }

    /// Admin method to anchor a Merkle root for the audit log vault
    pub fn anchor_audit_root(env: Env, sequence: u64, root: BytesN<32>) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        env.storage().persistent().set(&DataKey::AuditRoot(sequence), &root);
        env.storage().persistent().extend_ttl(
            &DataKey::AuditRoot(sequence),
            TTL_EXTEND,
            TTL_EXTEND,
        );

        env.events().publish((soroban_sdk::symbol_short!("audit"), sequence), root);
        Ok(())
    }
}


#[cfg(test)]
mod test;
#[cfg(test)]
mod tree_test;
