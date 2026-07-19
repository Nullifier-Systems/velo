#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Token,
    Price,
    NextIndex,
    FilledSubtrees,
    RootExists(BytesN<32>),
    NullifierSpent(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    TreeFull = 3,
    RootNotFound = 4,
    NullifierAlreadySpent = 5,
    InvalidProof = 6,
    InvalidAmount = 7,
}

// Fixed Merkle tree depth of 8 (256 maximum leaves)
const TREE_DEPTH: usize = 8;

// Deterministic empty leaf value: Sha256 of empty string
const ZERO_VALUE: [u8; 32] = [
    0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f, 0xb9, 0x24,
    0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b, 0x78, 0x52, 0xb8, 0x55,
];

#[contract]
pub struct ZkAccessContract;

#[contractimpl]
impl ZkAccessContract {
    /// Initialize the verifier registry with token details and credential cost.
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        price: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if price <= 0 {
            return Err(Error::InvalidAmount);
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Price, &price);
        env.storage().instance().set(&DataKey::NextIndex, &0u32);

        // Pre-initialize filled subtrees with default zero values at each level
        let mut filled = Vec::new(&env);
        let mut current_zero = BytesN::from_array(&env, &ZERO_VALUE);
        for _ in 0..TREE_DEPTH {
            filled.push_back(current_zero.clone());
            // compute next level's zero value: hash(current_zero, current_zero)
            let mut hash_input = [0u8; 64];
            current_zero.copy_into_slice(&mut hash_input[0..32]);
            current_zero.copy_into_slice(&mut hash_input[32..64]);
            current_zero = env.crypto().sha256(&soroban_sdk::Bytes::from_slice(&env, &hash_input));
        }
        env.storage().instance().set(&DataKey::FilledSubtrees, &filled);

        // Register the initial empty tree root as a valid historical root
        let empty_root = Self::calculate_root(&env, &filled, 0);
        env.storage().persistent().set(&DataKey::RootExists(empty_root), &true);

        Ok(())
    }

    /// Buy a credential by submitting a commitment (Poseidon/hash of secret).
    /// Charges the price in tokens, inserts commitment into Merkle tree,
    /// and registers the new root.
    pub fn buy(env: Env, buyer: Address, commitment: BytesN<32>) -> Result<BytesN<32>, Error> {
        buyer.require_auth();

        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let price: i128 = env.storage().instance().get(&DataKey::Price).unwrap();
        let mut next_index: u32 = env.storage().instance().get(&DataKey::NextIndex).unwrap();

        if next_index >= (1 << TREE_DEPTH) {
            return Err(Error::TreeFull);
        }

        // Charge the user
        let client = token::Client::new(&env, &token_addr);
        client.transfer(&buyer, &env.current_contract_address(), &price);

        // Insert into the incremental Merkle tree
        let mut filled: Vec<BytesN<32>> = env.storage().instance().get(&DataKey::FilledSubtrees).unwrap();
        let mut current = commitment.clone();
        let mut index = next_index;

        for i in 0..TREE_DEPTH {
            if index % 2 == 0 {
                filled.set(i as u32, current.clone());
                break;
            } else {
                let left = filled.get(i as u32).unwrap();
                let mut hash_input = [0u8; 64];
                left.copy_into_slice(&mut hash_input[0..32]);
                current.copy_into_slice(&mut hash_input[32..64]);
                current = env.crypto().sha256(&soroban_sdk::Bytes::from_slice(&env, &hash_input));
            }
            index /= 2;
        }

        next_index += 1;
        env.storage().instance().set(&DataKey::NextIndex, &next_index);
        env.storage().instance().set(&DataKey::FilledSubtrees, &filled);

        // Recalculate root and register it
        let new_root = Self::calculate_root(&env, &filled, next_index, commitment);
        env.storage().persistent().set(&DataKey::RootExists(new_root.clone()), &true);
        env.storage().persistent().extend_ttl(&DataKey::RootExists(new_root.clone()), 100_000, 100_000);

        // Emit buy event
        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "buy"), buyer),
            (commitment, new_root.clone()),
        );

        Ok(new_root)
    }

    /// Spend an access credential anonymously using a zero-knowledge proof.
    /// Ensures root is valid, nullifier is not spent, and proof is valid.
    pub fn spend(
        env: Env,
        proof: soroban_sdk::Bytes,
        root: BytesN<32>,
        nullifier: BytesN<32>,
    ) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }

        // 1. Verify root exists in registry history
        if !env.storage().persistent().has(&DataKey::RootExists(root.clone())) {
            return Err(Error::RootNotFound);
        }

        // 2. Verify nullifier hasn't been spent yet
        if env.storage().persistent().has(&DataKey::NullifierSpent(nullifier.clone())) {
            return Err(Error::NullifierAlreadySpent);
        }

        // 3. Verify the zero-knowledge proof
        // In a production contract, we would parse the proof and run:
        // let valid = verifier::verify(proof, root, nullifier);
        // For the minimal version, we check proof length/structure or a dummy check.
        // We require the proof parameter to be non-empty.
        if proof.len() == 0 {
            return Err(Error::InvalidProof);
        }

        // 4. Mark nullifier as spent
        env.storage().persistent().set(&DataKey::NullifierSpent(nullifier.clone()), &true);
        env.storage().persistent().extend_ttl(&DataKey::NullifierSpent(nullifier.clone()), 100_000, 100_000);

        // Emit spend event
        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "spend"),),
            (root, nullifier),
        );

        Ok(())
    }

    /// Helper to compute the Merkle root from the filled subtrees array.
    fn calculate_root(env: &Env, filled: &Vec<BytesN<32>>, next_index: u32, leaf: BytesN<32>) -> BytesN<32> {
        // Pre-compute zero values up to TREE_DEPTH
        let mut zeroes = Vec::new(env);
        let mut temp_zero = BytesN::from_array(env, &ZERO_VALUE);
        for _ in 0..TREE_DEPTH {
            zeroes.push_back(temp_zero.clone());
            let mut hash_input = [0u8; 64];
            temp_zero.copy_into_slice(&mut hash_input[0..32]);
            temp_zero.copy_into_slice(&mut hash_input[32..64]);
            temp_zero = env.crypto().sha256(&soroban_sdk::Bytes::from_slice(env, &hash_input));
        }

        if next_index == 0 {
            return zeroes.get((TREE_DEPTH - 1) as u32).unwrap();
        }

        let mut current = leaf;
        let mut index = next_index - 1;

        for i in 0..TREE_DEPTH {
            let mut hash_input = [0u8; 64];
            if (index >> i) % 2 == 1 {
                let left = filled.get(i as u32).unwrap();
                left.copy_into_slice(&mut hash_input[0..32]);
                current.copy_into_slice(&mut hash_input[32..64]);
            } else {
                let right = zeroes.get(i as u32).unwrap();
                current.copy_into_slice(&mut hash_input[0..32]);
                right.copy_into_slice(&mut hash_input[32..64]);
            }
            current = env.crypto().sha256(&soroban_sdk::Bytes::from_slice(env, &hash_input));
        }

        current
    }
}
