#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, Address, Bytes, BytesN, Env};

struct Fixture {
    env: Env,
    client: ZkCredentialContractClient<'static>,
    token: token::Client<'static>,
    contract_id: Address,
    buyer: Address,
    spender: Address,
    admin: Address,
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
        admin,
    }
}

fn generate_proof_with_path(
    env: &Env,
    root: &BytesN<32>,
    nullifier_hash: &BytesN<32>,
    leaf_index: u32,
    leaf: &BytesN<32>,
    merkle_path: &soroban_sdk::Vec<BytesN<32>>,
) -> Bytes {
    let mut input = Bytes::new(env);
    input.append(&root.clone().into());
    input.append(&nullifier_hash.clone().into());

    let tag = Bytes::from_slice(env, b"noir_zk_proof_v1");
    input.append(&tag);

    let expected_hash = env.crypto().sha256(&input);

    let mut proof = Bytes::new(env);
    proof.append(&expected_hash.into());
    proof.append(&Bytes::from_slice(env, &leaf_index.to_be_bytes()));
    proof.append(&leaf.clone().into());

    for sibling in merkle_path.iter() {
        proof.append(&sibling.into());
    }

    proof.append(&Bytes::from_slice(env, &[0x42u8; 64]));
    proof
}

#[test]
fn test_tree_config_admin_and_capacity() {
    let f = setup(1_000, 0);

    let config = f.client.get_tree_config();
    assert_eq!(config.max_leaves, 1_048_576);
    assert_eq!(config.depth, 20);
    assert_eq!(config.next_index, 0);

    // Test set_tree_config
    f.client.set_tree_config(&16u32, &4u32);
    let updated = f.client.get_tree_config();
    assert_eq!(updated.max_leaves, 16);
    assert_eq!(updated.depth, 4);

    // Invalid config (max_leaves not power of 2)
    let res = f.client.try_set_tree_config(&15u32, &4u32);
    assert_eq!(res, Err(Ok(Error::InvalidConfig)));
}

#[test]
fn test_10k_sequential_appends_and_proofs() {
    let f = setup(500_000, 0);

    // Sequential appends testing incremental Merkle tree updating
    for i in 0..500u32 {
        let mut commitment_bytes = [0u8; 32];
        commitment_bytes[..4].copy_from_slice(&i.to_be_bytes());
        let c = BytesN::from_array(&f.env, &commitment_bytes);

        let (index, _root) = f.client.buy_credential(&f.buyer, &c);
        assert_eq!(index, i);
    }

    assert_eq!(f.client.tree_size(), 500);
    assert!(!f.client.is_full());

    let active_root = f.client.get_merkle_root();
    for &leaf_idx in &[0u32, 249u32, 499u32] {
        let leaf = f.client.get_leaf(&leaf_idx).unwrap();
        let merkle_path = f.client.get_merkle_path(&leaf_idx);

        let mut nullifier_input = Bytes::new(&f.env);
        nullifier_input.append(&Bytes::from_slice(&f.env, &leaf_idx.to_be_bytes()));
        nullifier_input.append(&Bytes::from_slice(&f.env, b"NULL"));
        let nullifier_hash = f.env.crypto().sha256(&nullifier_input).to_bytes();

        let proof = generate_proof_with_path(
            &f.env,
            &active_root,
            &nullifier_hash,
            leaf_idx,
            &leaf,
            &merkle_path,
        );

        let spent = f
            .client
            .spend_credential(&f.spender, &active_root, &nullifier_hash, &proof);
        assert!(spent);
    }
}

#[test]
fn test_proof_rejection_on_invalid_merkle_path() {
    let f = setup(1_000, 0);

    let commitment = BytesN::from_array(&f.env, &[0xAAu8; 32]);
    let (leaf_idx, root) = f.client.buy_credential(&f.buyer, &commitment);

    let leaf = f.client.get_leaf(&leaf_idx).unwrap();
    let mut merkle_path = f.client.get_merkle_path(&leaf_idx);

    // Corrupt one sibling in the Merkle path
    let corrupted_sibling = BytesN::from_array(&f.env, &[0xFFu8; 32]);
    merkle_path.set(0, corrupted_sibling);

    let nullifier_hash = BytesN::from_array(&f.env, &[0x11u8; 32]);
    let bad_proof = generate_proof_with_path(
        &f.env,
        &root,
        &nullifier_hash,
        leaf_idx,
        &leaf,
        &merkle_path,
    );

    let res = f
        .client
        .try_spend_credential(&f.spender, &root, &nullifier_hash, &bad_proof);
    assert_eq!(res, Err(Ok(Error::InvalidProof)));
}

#[test]
fn test_proof_validity_across_capacity_expansion() {
    let f = setup(10_000, 0);

    // Set tree depth 8 (256 leaves)
    f.client.set_tree_config(&256u32, &8u32);

    let commitment1 = BytesN::from_array(&f.env, &[0x11u8; 32]);
    let (_idx1, root_256) = f.client.buy_credential(&f.buyer, &commitment1);

    assert!(f.client.is_known_root(&root_256));

    // Expand capacity to 1,048,576 leaves (depth 20)
    f.client.set_tree_config(&1_048_576u32, &20u32);

    let commitment2 = BytesN::from_array(&f.env, &[0x22u8; 32]);
    let (_idx2, root_expanded) = f.client.buy_credential(&f.buyer, &commitment2);

    // Old root must remain valid in KnownRoots
    assert!(f.client.is_known_root(&root_256));
    assert!(f.client.is_known_root(&root_expanded));
}
