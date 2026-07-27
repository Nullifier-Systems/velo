#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token, Address, Bytes, BytesN, Env,
};

struct Fixture {
    env: Env,
    client: ZkCredentialContractClient<'static>,
    token: token::Client<'static>,
    contract_id: Address,
    buyer: Address,
    spender: Address,
}

fn setup(mint_to_buyer: i128, price: i128) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let spender = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token = token::Client::new(&env, &token_addr);
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);
    token_admin.mint(&buyer, &mint_to_buyer);

    let contract_id = env.register_contract(None, ZkCredentialContract);
    let client = ZkCredentialContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_addr, &price);

    Fixture {
        env,
        client,
        token,
        contract_id,
        buyer,
        spender,
    }
}

fn generate_proof(env: &Env, root: &BytesN<32>, nullifier_hash: &BytesN<32>) -> Bytes {
    let mut input = Bytes::new(env);
    input.append(&root.clone().into());
    input.append(&nullifier_hash.clone().into());
    
    let tag = Bytes::from_slice(env, b"noir_zk_proof_v1");
    input.append(&tag);
    
    let expected_hash = env.crypto().sha256(&input);
    
    let mut proof = Bytes::new(env);
    proof.append(&expected_hash.into());
    proof.append(&Bytes::from_slice(env, &[0x42u8; 64]));
    proof
}

#[test]
fn test_end_to_end_credential_buy_and_spend() {
    let f = setup(1_000, 100);

    // Participant secret
    let secret = BytesN::from_array(&f.env, &[0xAAu8; 32]);
    let commitment = f.env.crypto().sha256(&secret.clone().into()).to_bytes();

    // 1. Buy Credential
    let (leaf_idx, new_root) = f.client.buy_credential(&f.buyer, &commitment);
    assert_eq!(leaf_idx, 0);
    assert_eq!(f.client.get_commitment_count(), 1);
    assert_eq!(f.client.get_merkle_root(), new_root);
    assert!(f.client.is_known_root(&new_root));

    // Verify token deduction from buyer to contract
    assert_eq!(f.token.balance(&f.buyer), 900);
    assert_eq!(f.token.balance(&f.contract_id), 100);

    // 2. Derive Nullifier and ZK proof off-chain
    let mut nullifier_input = Bytes::new(&f.env);
    nullifier_input.append(&secret.clone().into());
    nullifier_input.append(&Bytes::from_slice(&f.env, b"NULL"));
    let nullifier_hash = f.env.crypto().sha256(&nullifier_input).to_bytes();

    let proof = generate_proof(&f.env, &new_root, &nullifier_hash);

    // Check nullifier not spent initially
    assert!(!f.client.is_nullifier_spent(&nullifier_hash));

    // 3. Spend Credential via ZK proof
    let spend_res = f.client.spend_credential(&f.spender, &new_root, &nullifier_hash, &proof);
    assert_eq!(spend_res, true);

    // 4. Confirm nullifier marked as spent
    assert!(f.client.is_nullifier_spent(&nullifier_hash));
}

#[test]
fn test_second_spend_attempt_rejected_via_nullifier() {
    let f = setup(1_000, 100);

    let secret = BytesN::from_array(&f.env, &[0xBBu8; 32]);
    let commitment = f.env.crypto().sha256(&secret.clone().into()).to_bytes();

    let (_, root) = f.client.buy_credential(&f.buyer, &commitment);

    let mut nullifier_input = Bytes::new(&f.env);
    nullifier_input.append(&secret.clone().into());
    nullifier_input.append(&Bytes::from_slice(&f.env, b"NULL"));
    let nullifier_hash = f.env.crypto().sha256(&nullifier_input).to_bytes();

    let proof = generate_proof(&f.env, &root, &nullifier_hash);

    // First spend succeeds
    let spend1 = f.client.spend_credential(&f.spender, &root, &nullifier_hash, &proof);
    assert_eq!(spend1, true);

    // Second spend with the exact same nullifier fails
    let spend2 = f.client.try_spend_credential(&f.spender, &root, &nullifier_hash, &proof);
    assert_eq!(spend2, Err(Ok(Error::NullifierAlreadySpent)));
}

#[test]
fn test_unknown_merkle_root_rejected() {
    let f = setup(1_000, 100);

    let fake_root = BytesN::from_array(&f.env, &[0xFFu8; 32]);
    let nullifier_hash = BytesN::from_array(&f.env, &[0x11u8; 32]);
    let proof = generate_proof(&f.env, &fake_root, &nullifier_hash);

    let res = f.client.try_spend_credential(&f.spender, &fake_root, &nullifier_hash, &proof);
    assert_eq!(res, Err(Ok(Error::RootNotFound)));
}

#[test]
fn test_invalid_proof_rejected() {
    let f = setup(1_000, 100);

    let secret = BytesN::from_array(&f.env, &[0xCCu8; 32]);
    let commitment = f.env.crypto().sha256(&secret.clone().into()).to_bytes();

    let (_, root) = f.client.buy_credential(&f.buyer, &commitment);

    let nullifier_hash = BytesN::from_array(&f.env, &[0x22u8; 32]);
    let invalid_proof = Bytes::from_slice(&f.env, &[0x00u8; 64]);

    let res = f.client.try_spend_credential(&f.spender, &root, &nullifier_hash, &invalid_proof);
    assert_eq!(res, Err(Ok(Error::InvalidProof)));
}
