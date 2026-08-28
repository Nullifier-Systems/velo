use super::*;
use soroban_sdk::testutils::Address as _;

fn setup_jury_env() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.budget().reset_unlimited();
    let admin = Address::generate(&env);
    (env, admin)
}

fn register_juror(env: &Env, client: &JuryArbitrationClient, amount: i128, rep: u32) -> Address {
    let juror = Address::generate(&env);
    client.stake_as_juror(&juror, &amount, &rep);
    juror
}

#[test]
fn test_stake_as_juror() {
    let (env, _admin) = setup_jury_env();
    let contract_id = env.register_contract(None, JuryArbitration);
    let client = JuryArbitrationClient::new(&env, &contract_id);

    let juror = Address::generate(&env);
    let result = client.try_stake_as_juror(&juror, &100_000_000, &100);
    assert!(result.is_ok());

    let stake = client.get_juror_stake(&juror);
    assert!(stake.is_some());
    let s = stake.unwrap();
    assert_eq!(s.staked_amount, 100_000_000);
    assert_eq!(s.reputation_score, 100);
    assert!(s.is_active);
}

#[test]
fn test_stake_insufficient_amount() {
    let (env, _admin) = setup_jury_env();
    let contract_id = env.register_contract(None, JuryArbitration);
    let client = JuryArbitrationClient::new(&env, &contract_id);

    let juror = Address::generate(&env);
    let result = client.try_stake_as_juror(&juror, &50_000_000, &100);
    assert!(result.is_err());
}

#[test]
fn test_stake_duplicate_juror() {
    let (env, _admin) = setup_jury_env();
    let contract_id = env.register_contract(None, JuryArbitration);
    let client = JuryArbitrationClient::new(&env, &contract_id);

    let juror = Address::generate(&env);
    client.stake_as_juror(&juror, &100_000_000, &100);

    let result = client.try_stake_as_juror(&juror, &200_000_000, &100);
    assert!(result.is_err());
}

#[test]
fn test_unstake_juror() {
    let (env, _admin) = setup_jury_env();
    let contract_id = env.register_contract(None, JuryArbitration);
    let client = JuryArbitrationClient::new(&env, &contract_id);

    let juror = Address::generate(&env);
    client.stake_as_juror(&juror, &100_000_000, &100);

    let returned = client.unstake_juror(&juror);
    assert_eq!(returned, 100_000_000);

    let stake = client.get_juror_stake(&juror);
    assert!(stake.is_none());
}

#[test]
fn test_create_panel_requires_5_jurors() {
    let (env, _admin) = setup_jury_env();
    let contract_id = env.register_contract(None, JuryArbitration);
    let client = JuryArbitrationClient::new(&env, &contract_id);

    let mut jurors = soroban_sdk::Vec::new(&env);
    for _ in 0..4 {
        jurors.push_back(Address::generate(&env));
    }

    let panel_id = BytesN::from_array(&env, &[1u8; 32]);
    let trade_id = BytesN::from_array(&env, &[2u8; 32]);

    let result = client.try_create_panel(&panel_id, &trade_id, &jurors, &1_000_000_000);
    assert!(result.is_err());
}

#[test]
fn test_3_vs_2_vote_resolution() {
    let (env, _admin) = setup_jury_env();
    let contract_id = env.register_contract(None, JuryArbitration);
    let client = JuryArbitrationClient::new(&env, &contract_id);

    // Register 5 jurors
    let mut juror_addrs = soroban_sdk::Vec::new(&env);
    for _ in 0..5 {
        let j = Address::generate(&env);
        client.stake_as_juror(&j, &100_000_000, &100);
        juror_addrs.push_back(j);
    }

    let panel_id = BytesN::from_array(&env, &[1u8; 32]);
    let trade_id = BytesN::from_array(&env, &[2u8; 32]);
    client.create_panel(&panel_id, &trade_id, &juror_addrs, &1_000_000_000);

    // Submit commits: 3 BUYER, 2 SELLER
    let salt = BytesN::from_array(&env, &[0xAAu8; 32]);
    for i in 0..5 {
        let juror = juror_addrs.get(i).unwrap();
        let vote_str = if i < 3 { b"BUYER" } else { b"SELLER" };
        let mut payload = Bytes::from_slice(&env, vote_str);
        payload.append(&salt.clone().into());
        let hash = env.crypto().sha256(&payload);
        client.submit_vote_commit(&panel_id, &juror, &hash.into());
    }

    // Start reveal phase
    client.start_reveal_phase(&panel_id);

    // Submit reveals
    for i in 0..5 {
        let juror = juror_addrs.get(i).unwrap();
        let vote = if i < 3 {
            JurorVote::Buyer
        } else {
            JurorVote::Seller
        };
        client.submit_vote_reveal(&panel_id, &juror, &vote, &salt);
    }

    // Resolve
    let (resolution, buyer_share, slashed) = client.resolve_panel(&panel_id);
    assert_eq!(resolution, JurorVote::Buyer);
    assert_eq!(buyer_share, 10_000);
    assert_eq!(slashed.len(), 2); // 2 minority voters slashed
}

#[test]
fn test_minority_voters_get_slashed() {
    let (env, _admin) = setup_jury_env();
    let contract_id = env.register_contract(None, JuryArbitration);
    let client = JuryArbitrationClient::new(&env, &contract_id);

    let mut juror_addrs = soroban_sdk::Vec::new(&env);
    for _ in 0..5 {
        let j = Address::generate(&env);
        client.stake_as_juror(&j, &200_000_000, &100);
        juror_addrs.push_back(j);
    }

    let panel_id = BytesN::from_array(&env, &[1u8; 32]);
    let trade_id = BytesN::from_array(&env, &[2u8; 32]);
    client.create_panel(&panel_id, &trade_id, &juror_addrs, &1_000_000_000);

    let salt = BytesN::from_array(&env, &[0xBBu8; 32]);
    // 4 BUYER, 1 SELLER
    for i in 0..5 {
        let juror = juror_addrs.get(i).unwrap();
        let vote_str = if i < 4 { b"BUYER" } else { b"SELLER" };
        let mut payload = Bytes::from_slice(&env, vote_str);
        payload.append(&salt.clone().into());
        let hash = env.crypto().sha256(&payload);
        client.submit_vote_commit(&panel_id, &juror, &hash.into());
    }

    client.start_reveal_phase(&panel_id);

    for i in 0..5 {
        let juror = juror_addrs.get(i).unwrap();
        let vote = if i < 4 {
            JurorVote::Buyer
        } else {
            JurorVote::Seller
        };
        client.submit_vote_reveal(&panel_id, &juror, &vote, &salt);
    }

    let (resolution, _, slashed) = client.resolve_panel(&panel_id);
    assert_eq!(resolution, JurorVote::Buyer);
    // 1 minority voter slashed (50% of stake)
    assert_eq!(slashed.len(), 1);

    let minority_juror = juror_addrs.get(4).unwrap();
    let stake = client.get_juror_stake(&minority_juror).unwrap();
    assert_eq!(stake.staked_amount, 100_000_000); // 200M - 50% = 100M
    assert_eq!(stake.reputation_score, 75); // 100 - 25
}

#[test]
fn test_commit_reveal_hash_mismatch_fails() {
    let (env, _admin) = setup_jury_env();
    let contract_id = env.register_contract(None, JuryArbitration);
    let client = JuryArbitrationClient::new(&env, &contract_id);

    let mut juror_addrs = soroban_sdk::Vec::new(&env);
    for _ in 0..5 {
        let j = Address::generate(&env);
        client.stake_as_juror(&j, &100_000_000, &100);
        juror_addrs.push_back(j);
    }

    let panel_id = BytesN::from_array(&env, &[1u8; 32]);
    let trade_id = BytesN::from_array(&env, &[2u8; 32]);
    client.create_panel(&panel_id, &trade_id, &juror_addrs, &1_000_000_000);

    // Commit with one salt
    let salt1 = BytesN::from_array(&env, &[0xAAu8; 32]);
    let juror = juror_addrs.get(0).unwrap();
    let mut payload = Bytes::from_slice(&env, b"BUYER");
    payload.append(&salt1.clone().into());
    let hash = env.crypto().sha256(&payload);
    client.submit_vote_commit(&panel_id, &juror, &hash.into());

    client.start_reveal_phase(&panel_id);

    // Try to reveal with a different salt — should fail
    let salt2 = BytesN::from_array(&env, &[0xBBu8; 32]);
    let result = client.try_submit_vote_reveal(&panel_id, &juror, &JurorVote::Buyer, &salt2);
    assert!(result.is_err());
}

#[test]
fn test_active_juror_count() {
    let (env, _admin) = setup_jury_env();
    let contract_id = env.register_contract(None, JuryArbitration);
    let client = JuryArbitrationClient::new(&env, &contract_id);

    assert_eq!(client.get_active_juror_count(), 0);

    let j1 = register_juror(&env, &client, 100_000_000, 100);
    let j2 = register_juror(&env, &client, 200_000_000, 90);
    assert_eq!(client.get_active_juror_count(), 2);

    client.unstake_juror(&j1);
    assert_eq!(client.get_active_juror_count(), 1);
}

#[test]
fn test_total_panels_count() {
    let (env, _admin) = setup_jury_env();
    let contract_id = env.register_contract(None, JuryArbitration);
    let client = JuryArbitrationClient::new(&env, &contract_id);

    assert_eq!(client.get_total_panels(), 0);

    let mut juror_addrs = soroban_sdk::Vec::new(&env);
    for _ in 0..5 {
        let j = Address::generate(&env);
        client.stake_as_juror(&j, &100_000_000, &100);
        juror_addrs.push_back(j);
    }

    let panel_id = BytesN::from_array(&env, &[1u8; 32]);
    let trade_id = BytesN::from_array(&env, &[2u8; 32]);
    client.create_panel(&panel_id, &trade_id, &juror_addrs, &1_000_000_000);
    assert_eq!(client.get_total_panels(), 1);
}
