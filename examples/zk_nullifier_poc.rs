//! POC: ZK nullifier claim verification on Soroban.
//!
//! Demonstrates the hybrid architecture:
//!   1. Off-chain ZK proof is verified by a ZK Verifier Node (Barretenberg).
//!   2. The node signs an attestation with its Ed25519 key.
//!   3. This Soroban contract verifies the attestation, checks the nullifier,
//!      records it, and releases escrow funds.

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    OracleKey,
    Nullifier(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    NullifierAlreadySpent = 3,
    InvalidAttestation = 4,
}

#[contract]
pub struct ZKNullifierClaim;

#[contractimpl]
impl ZKNullifierClaim {
    pub fn initialize(env: Env, oracle_pubkey: BytesN<32>) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::OracleKey) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage()
            .instance()
            .set(&DataKey::OracleKey, &oracle_pubkey);
        Ok(())
    }

    /// Verify an oracle-signed ZK attestation and record the nullifier.
    ///
    /// `attestation_payload` = nullifier_hash (32 B) || claim_id (32 B) || timestamp (8 B)
    /// `signature` = Ed25519 signature over the payload.
    pub fn claim_with_zk_attestation(
        env: Env,
        claimant: Address,
        attestation_payload: Bytes,
        signature: BytesN<64>,
    ) -> Result<(), Error> {
        let oracle_key: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::OracleKey)
            .ok_or(Error::NotInitialized)?;

        claimant.require_auth();

        // Extract nullifier hash from payload (first 32 bytes)
        let nullifier_hash: BytesN<32> = attestation_payload
            .slice(0..32)
            .try_into()
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]));

        // Reject if already spent
        if env
            .storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier_hash.clone()))
        {
            return Err(Error::NullifierAlreadySpent);
        }

        // Verify oracle Ed25519 signature over the payload
        let valid = env
            .crypto()
            .ed25519_verify(&oracle_key, &attestation_payload, &signature);
        if !valid {
            return Err(Error::InvalidAttestation);
        }

        // Record nullifier as spent
        env.storage()
            .persistent()
            .set(&DataKey::Nullifier(nullifier_hash.clone()), &true);

        env.events()
            .publish((symbol_short!("claim"), claimant), (nullifier_hash,));

        Ok(())
    }

    pub fn is_nullifier_spent(env: Env, nullifier_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier_hash))
    }
}
