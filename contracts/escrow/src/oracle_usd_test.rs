//! Issue #334 — multi-asset USD oracle rate conversion / max USD escrow limit.

use super::*;
use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, token, vec, Address, BytesN,
    Env, Vec,
};

#[contracttype]
#[derive(Clone)]
enum MockOracleKey {
    Decimals,
    Price(Address),
}

/// Minimal SEP-40-shaped mock oracle for unit tests.
#[contract]
pub struct MockPriceOracle;

#[contractimpl]
impl MockPriceOracle {
    pub fn init(env: Env, decimals: u32) {
        env.storage()
            .instance()
            .set(&MockOracleKey::Decimals, &decimals);
    }

    pub fn set_price(env: Env, token: Address, price: i128) {
        env.storage()
            .instance()
            .set(&MockOracleKey::Price(token), &price);
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&MockOracleKey::Decimals)
            .unwrap_or(0)
    }

    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
        let token = match asset {
            OracleAsset::Stellar(addr) => addr,
            OracleAsset::Other(_) => return None,
        };
        let price: i128 = env.storage().instance().get(&MockOracleKey::Price(token))?;
        Some(PriceData {
            price,
            timestamp: env.ledger().timestamp(),
        })
    }
}

fn arb_set(env: &Env) -> ArbitratorSet {
    ArbitratorSet {
        keys: Vec::new(env),
        threshold_epoch1: 0,
        threshold_epoch2: 0,
        t1_ledgers: 100,
        t2_ledgers: 200,
    }
}

struct OracleFixture {
    env: Env,
    client: EscrowContractClient<'static>,
    buyer: Address,
    seller: Address,
    secret_hash: BytesN<32>,
    no_sigs: Vec<Address>,
    oracle_id: Address,
}

fn setup_with_oracle(max_usd: i128, price: i128, decimals: u32) -> OracleFixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    token::StellarAssetClient::new(&env, &token_addr).mint(&buyer, &1_000_000);

    let oracle_id = env.register_contract(None, MockPriceOracle);
    let oracle = MockPriceOracleClient::new(&env, &oracle_id);
    oracle.init(&decimals);
    oracle.set_price(&token_addr, &price);

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_addr, &50, &arb_set(&env));

    let no_sigs: Vec<Address> = Vec::new(&env);
    client.set_oracle_address(&oracle_id, &no_sigs);
    client.set_max_usd_limit(&max_usd, &no_sigs);

    let secret = BytesN::from_array(&env, &[7u8; 32]);
    let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();

    OracleFixture {
        env,
        client,
        buyer,
        seller,
        secret_hash,
        no_sigs,
        oracle_id,
    }
}

#[test]
fn lock_within_max_usd_limit_succeeds() {
    // price = 1.0 USD (decimals=0), max = 1000, amount = 500 → ok
    let f = setup_with_oracle(1_000, 1, 0);
    let id = BytesN::from_array(&f.env, &[1u8; 32]);
    f.client
        .lock(&id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
    assert_eq!(f.client.get_trade(&id).unwrap().amount, 500);
}

#[test]
#[should_panic(expected = "43")]
fn lock_exceeding_max_usd_limit_fails() {
    // price = 1.0 USD, max = 1000, amount = 1001 → ExceedsMaxUsdLimit (31)
    let f = setup_with_oracle(1_000, 1, 0);
    let id = BytesN::from_array(&f.env, &[1u8; 32]);
    f.client
        .lock(&id, &f.seller, &f.buyer, &1_001, &f.secret_hash, &100);
}

#[test]
#[should_panic(expected = "43")]
fn lock_exceeds_limit_with_scaled_oracle_price() {
    // price = $2.00 with 7 decimals, max = 1000 whole USD, amount = 600
    // → usd = 600 * 2 = 1200 > 1000
    let f = setup_with_oracle(1_000, 2_0000000, 7);
    let id = BytesN::from_array(&f.env, &[2u8; 32]);
    f.client
        .lock(&id, &f.seller, &f.buyer, &600, &f.secret_hash, &100);
}

#[test]
fn set_max_usd_limit_and_oracle_are_admin_gated() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let outsider = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let oracle_id = env.register_contract(None, MockPriceOracle);
    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    client.initialize(&admin, &token_addr, &50, &arb_set(&env));

    // Clear auths — privileged setters must fail without admin authorization.
    env.set_auths(&[]);
    let empty: Vec<Address> = Vec::new(&env);
    assert!(client.try_set_oracle_address(&oracle_id, &empty).is_err());
    assert!(client.try_set_max_usd_limit(&500, &empty).is_err());

    let fake = vec![&env, outsider];
    assert!(client.try_set_oracle_address(&oracle_id, &fake).is_err());
    assert!(client.try_set_max_usd_limit(&500, &fake).is_err());

    env.mock_all_auths();
    client.set_oracle_address(&oracle_id, &empty);
    client.set_max_usd_limit(&5_000, &empty);
    assert_eq!(client.get_oracle_address(), Some(oracle_id));
    assert_eq!(client.get_max_usd_limit(), 5_000);
}

#[test]
fn unset_max_usd_limit_skips_oracle_check() {
    // Default max_usd_limit = 0 → unlimited; lock succeeds without an oracle.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    token::StellarAssetClient::new(&env, &token_addr).mint(&buyer, &1_000);
    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_addr, &50, &arb_set(&env));
    assert_eq!(client.get_max_usd_limit(), 0);
    let secret = BytesN::from_array(&env, &[7u8; 32]);
    let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
    let id = BytesN::from_array(&env, &[1u8; 32]);
    client.lock(&id, &seller, &buyer, &500, &secret_hash, &100);
}

#[test]
#[should_panic(expected = "44")]
fn configured_limit_without_oracle_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    token::StellarAssetClient::new(&env, &token_addr).mint(&buyer, &1_000);
    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_addr, &50, &arb_set(&env));
    let empty: Vec<Address> = Vec::new(&env);
    client.set_max_usd_limit(&100, &empty);
    let secret = BytesN::from_array(&env, &[7u8; 32]);
    let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
    let id = BytesN::from_array(&env, &[1u8; 32]);
    client.lock(&id, &seller, &buyer, &50, &secret_hash, &100);
}

#[test]
fn admin_can_raise_limit_to_allow_previously_blocked_amount() {
    let f = setup_with_oracle(100, 1, 0);
    let id = BytesN::from_array(&f.env, &[3u8; 32]);
    // First raise the limit, then lock an amount that would have been blocked.
    f.client.set_max_usd_limit(&1_000, &f.no_sigs);
    f.client
        .lock(&id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
    assert!(f.client.get_trade(&id).is_some());
    let _ = f.oracle_id;
}
