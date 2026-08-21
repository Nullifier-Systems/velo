//! Tests for decentralized jury dispute arbitration and slashing functionality

use soroban_sdk::testutils::{Ledger, LedgerInfo};
use soroban_sdk::{Address, BytesN, Env};

use crate::{
    test::{setup, Fixture},
    ArbitratorMeta, Error, JuryState, JuryVote, SlashingConfig,
};

#[test]
fn test_jury_selection() {
    let f = setup();
    let id = BytesN::from_array(&f.env, &[1; 32]);

    // Setup arbitrators in the pool
    let arb1 = Address::generate(&f.env);
    let arb2 = Address::generate(&f.env);
    let arb3 = Address::generate(&f.env);
    let arb4 = Address::generate(&f.env);
    let arb5 = Address::generate(&f.env);

    f.client.join_arbitrator_pool(&arb1);
    f.client.join_arbitrator_pool(&arb2);
    f.client.join_arbitrator_pool(&arb3);
    f.client.join_arbitrator_pool(&arb4);
    f.client.join_arbitrator_pool(&arb5);

    // Advance ledger past activation period
    f.env.ledger().set(LedgerInfo {
        protocol_version: 1,
        sequence_number: 6 * 60 * 24 + 100,
        timestamp: 0,
        network_id: Default::default(),
        base_reserve: 0,
        min_persistent_entry_ttl: 0,
        min_temp_entry_ttl: 0,
        max_entry_ttl: 0,
    });

    // Lock a trade
    let secret_hash = BytesN::from_array(&f.env, &[2; 32]);
    f.client.lock(&id, &f.seller, &f.buyer, &1_000_000, &secret_hash, &100);

    // Raise dispute
    f.client.raise_dispute(&f.buyer, &id);

    // Select jury
    let jurors = f.client.try_select_jury(&id);
    assert!(jurors.is_ok());

    let selected_jurors = jurors.unwrap();
    assert_eq!(selected_jurors.len(), 5);

    // Verify jury state was created
    let jury_state = f.client.get_jury_state(&id);
    assert!(jury_state.is_some());
    let state = jury_state.unwrap();
    assert_eq!(state.jurors.len(), 5);
    assert_eq!(state.votes.len(), 0);
}

#[test]
fn test_jury_selection_insufficient_arbitrators() {
    let f = setup();
    let id = BytesN::from_array(&f.env, &[1; 32]);

    // Only add 2 arbitrators (less than minimum jury size)
    let arb1 = Address::generate(&f.env);
    let arb2 = Address::generate(&f.env);

    f.client.join_arbitrator_pool(&arb1);
    f.client.join_arbitrator_pool(&arb2);

    f.env.ledger().set(LedgerInfo {
        protocol_version: 1,
        sequence_number: 6 * 60 * 24 + 100,
        timestamp: 0,
        network_id: Default::default(),
        base_reserve: 0,
        min_persistent_entry_ttl: 0,
        min_temp_entry_ttl: 0,
        max_entry_ttl: 0,
    });

    let secret_hash = BytesN::from_array(&f.env, &[2; 32]);
    f.client.lock(&id, &f.seller, &f.buyer, &1_000_000, &secret_hash, &100);
    f.client.raise_dispute(&f.buyer, &id);

    let result = f.client.try_select_jury(&id);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Error::InsufficientJurors);
}

#[test]
fn test_cast_vote() {
    let f = setup();
    let id = BytesN::from_array(&f.env, &[1; 32]);

    let arb1 = Address::generate(&f.env);
    let arb2 = Address::generate(&f.env);
    let arb3 = Address::generate(&f.env);

    f.client.join_arbitrator_pool(&arb1);
    f.client.join_arbitrator_pool(&arb2);
    f.client.join_arbitrator_pool(&arb3);

    f.client.set_jury_size(&3, &f.no_sigs);

    f.env.ledger().set(LedgerInfo {
        protocol_version: 1,
        sequence_number: 6 * 60 * 24 + 100,
        timestamp: 0,
        network_id: Default::default(),
        base_reserve: 0,
        min_persistent_entry_ttl: 0,
        min_temp_entry_ttl: 0,
        max_entry_ttl: 0,
    });

    let secret_hash = BytesN::from_array(&f.env, &[2; 32]);
    f.client.lock(&id, &f.seller, &f.buyer, &1_000_000, &secret_hash, &100);
    f.client.raise_dispute(&f.buyer, &id);

    let jurors = f.client.select_jury(&id);
    assert_eq!(jurors.len(), 3);

    let result = f.client.try_cast_vote(&id, &arb1, true);
    assert!(result.is_ok());

    let result = f.client.try_cast_vote(&id, &arb2, false);
    assert!(result.is_ok());

    let jury_state = f.client.get_jury_state(&id).unwrap();
    assert_eq!(jury_state.votes.len(), 2);
}

#[test]
fn test_cast_vote_not_juror() {
    let f = setup();
    let id = BytesN::from_array(&f.env, &[1; 32]);

    let arb1 = Address::generate(&f.env);
    let non_juror = Address::generate(&f.env);

    f.client.join_arbitrator_pool(&arb1);
    f.client.set_jury_size(&1, &f.no_sigs);

    f.env.ledger().set(LedgerInfo {
        protocol_version: 1,
        sequence_number: 6 * 60 * 24 + 100,
        timestamp: 0,
        network_id: Default::default(),
        base_reserve: 0,
        min_persistent_entry_ttl: 0,
        min_temp_entry_ttl: 0,
        max_entry_ttl: 0,
    });

    let secret_hash = BytesN::from_array(&f.env, &[2; 32]);
    f.client.lock(&id, &f.seller, &f.buyer, &1_000_000, &secret_hash, &100);
    f.client.raise_dispute(&f.buyer, &id);
    f.client.select_jury(&id);

    let result = f.client.try_cast_vote(&id, &non_juror, true);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Error::NotAJuror);
}

#[test]
fn test_cast_vote_duplicate() {
    let f = setup();
    let id = BytesN::from_array(&f.env, &[1; 32]);

    let arb1 = Address::generate(&f.env);

    f.client.join_arbitrator_pool(&arb1);
    f.client.set_jury_size(&1, &f.no_sigs);

    f.env.ledger().set(LedgerInfo {
        protocol_version: 1,
        sequence_number: 6 * 60 * 24 + 100,
        timestamp: 0,
        network_id: Default::default(),
        base_reserve: 0,
        min_persistent_entry_ttl: 0,
        min_temp_entry_ttl: 0,
        max_entry_ttl: 0,
    });

    let secret_hash = BytesN::from_array(&f.env, &[2; 32]);
    f.client.lock(&id, &f.seller, &f.buyer, &1_000_000, &secret_hash, &100);
    f.client.raise_dispute(&f.buyer, &id);
    f.client.select_jury(&id);

    f.client.cast_vote(&id, &arb1, true);

    let result = f.client.try_cast_vote(&id, &arb1, false);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Error::AlreadyVoted);
}

#[test]
fn test_slashing_config() {
    let f = setup();

    let config = SlashingConfig {
        inactivity_slash_bps: 2000,
        malicious_slash_bps: 6000,
        inactivity_threshold_ledgers: 6 * 60 * 24 * 14,
        honest_juror_reward_bps: 200,
    };

    let result = f.client.try_set_slashing_config(&config, &f.no_sigs);
    assert!(result.is_ok());

    let retrieved = f.client.get_slashing_config();
    assert_eq!(retrieved.inactivity_slash_bps, 2000);
    assert_eq!(retrieved.malicious_slash_bps, 6000);
}

#[test]
fn test_jury_size_configuration() {
    let f = setup();

    assert!(f.client.try_set_jury_size(&3, &f.no_sigs).is_ok());
    assert!(f.client.try_set_jury_size(&7, &f.no_sigs).is_ok());

    assert!(f.client.try_set_jury_size(&2, &f.no_sigs).is_err());
    assert!(f.client.try_set_jury_size(&12, &f.no_sigs).is_err());
}

#[test]
fn test_voting_window_configuration() {
    let f = setup();

    assert!(f.client.try_set_voting_window(&100, &f.no_sigs).is_ok());
    assert!(f.client.try_set_voting_window(&5, &f.no_sigs).is_err());
}
