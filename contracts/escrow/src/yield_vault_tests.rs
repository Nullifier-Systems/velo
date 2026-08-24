//! Share-math tests for the cross-asset yield aggregation vault (#408).
//!
//! Coverage map from the issue's test plan:
//! - "Share Math Test": pro-rata minting, harvest raising the exchange rate,
//!   and the contributor-note invariant that the rate NEVER decreases.
//! - Escrow integration: idle-reserve deployment + instant recall for
//!   settlement buffer top-ups.

use crate::yield_vault::{YieldVaultContract, YieldVaultContractClient, RATE_SCALE};
use crate::{ArbitratorSet, EscrowContract, EscrowContractClient};
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Vec,
};

/// Vault + token fixture. `mock_all_auths` stands in for provider and
/// strategy signatures; production auth paths are exercised on-chain.
struct VaultFixture {
    env: Env,
    client: YieldVaultContractClient<'static>,
    token: TokenClient<'static>,
    token_admin: StellarAssetClient<'static>,
    admin: Address,
    strategy: Address,
    vault_id: Address,
}

/// Push-then-deposit convenience mirroring the real user flow: transfer
/// underlying into the vault, then claim the pro-rata shares.
fn deposit_for(f: &VaultFixture, holder: &Address, amount: i128) -> i128 {
    f.token
        .transfer(holder, &f.vault_id, &amount);
    f.client.deposit(holder, &amount)
}

fn vault_setup() -> VaultFixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = TokenClient::new(&env, &sac.address());
    let token_admin_client = StellarAssetClient::new(&env, &sac.address());
    let strategy = Address::generate(&env);

    let contract_id = env.register_contract(None, YieldVaultContract);
    let client = YieldVaultContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token.address);

    // Fund the simulated external yield strategy so `harvest()` transfers
    // settle against real balances.
    token_admin_client.mint(&strategy, &1_000_000);

    VaultFixture {
        env,
        client,
        token,
        token_admin: token_admin_client,
        admin,
        strategy,
        vault_id: contract_id.clone(),
    }
}

/// Full escrow fixture (mirrors tranche_tests setup) plus a registered yield
/// vault and idle reserves minted straight to the escrow contract address.
struct EscrowFixture {
    env: Env,
    client: EscrowContractClient<'static>,
    vault_client: YieldVaultContractClient<'static>,
    token: TokenClient<'static>,
    token_admin: StellarAssetClient<'static>,
}

fn escrow_with_yield_vault(initial_escrow_balance: i128) -> EscrowFixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = TokenClient::new(&env, &sac.address());
    let token_admin_client = StellarAssetClient::new(&env, &sac.address());

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let arb_set = ArbitratorSet {
        keys: Vec::new(&env),
        threshold_epoch1: 1,
        threshold_epoch2: 2,
        t1_ledgers: 100,
        t2_ledgers: 200,
    };
    client.initialize(&admin, &token.address, &0u32, &arb_set);

    // Seed idle reserves directly at the escrow contract address.
    token_admin_client.mint(&contract_id, &initial_escrow_balance);

    // Deploy the external yield vault and point the escrow at it.
    let vault_id = env.register_contract(None, YieldVaultContract);
    let vault_client = YieldVaultContractClient::new(&env, &vault_id);
    vault_client.initialize(&admin, &token.address);
    client.set_yield_vault(&vault_id, &Vec::new(&env));

    EscrowFixture {
        env,
        client,
        vault_client,
        token,
        token_admin: token_admin_client,
    }
}

fn assert_rate_holds(before: i128, after: i128) {
    assert!(
        after >= before,
        "exchange rate decreased: {before} -> {after}"
    );
}

/// Core share-math scenario from the issue's test plan: pro-rata minting,
/// harvest raising the exchange rate without minting shares, and every
/// depositor exiting at their appreciated slice.
#[test]
fn deposit_mints_proportional_shares_and_harvest_raises_rate() {
    let f = vault_setup();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.token_admin.mint(&alice, &10_000);
    f.token_admin.mint(&bob, &10_000);

    // First deposit seeds the pool at 1:1; second is exactly pro-rata.
    let alice_shares = deposit_for(&f, &alice, 1_000);
    assert_eq!(alice_shares, 1_000);
    let bob_shares = deposit_for(&f, &bob, 1_000);
    assert_eq!(bob_shares, 1_000);

    assert_eq!(f.client.total_shares(), 2_000);
    assert_eq!(f.client.total_assets(), 2_000);
    assert_eq!(f.client.exchange_rate(), RATE_SCALE);

    // Harvest 80 of strategy yield: assets rise to 2_080 with shares still
    // 2_000 → the rate ratchets to 1.04 and NO new shares are minted.
    let new_rate = f.client.harvest(&f.strategy, &80);
    assert_eq!(f.client.total_shares(), 2_000);
    let expected = 1_040 * RATE_SCALE / 1_000;
    assert_eq!(new_rate, expected);
    assert_eq!(f.client.exchange_rate(), expected);

    // Each provider exits at their appreciated pro-rata slice of the pool.
    let payout = f.client.withdraw(&alice, &alice_shares);
    assert_eq!(payout, 1_040);
    assert_eq!(f.token.balance(&alice), 10_040);

    let bob_payout = f.client.withdraw(&bob, &bob_shares);
    assert_eq!(bob_payout, 1_040);
    assert_eq!(f.client.total_assets(), 0);
    assert_eq!(f.client.total_shares(), 0);
}

/// The contributor-note invariant exercised over an adversarial interleaving
/// of deposits, harvests and partial withdrawals: the scaled exchange rate is
/// monotonic non-decreasing at EVERY step.
#[test]
fn exchange_rate_never_decreases_through_full_lifecycle() {
    let f = vault_setup();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.token_admin.mint(&alice, &100_000);
    f.token_admin.mint(&bob, &100_000);

    let mut prev_rate = f.client.exchange_rate();

    let actions: [(&str, i128); 8] = [
        ("dep_alice", 5_000),
        ("dep_bob", 7_500),
        ("harvest", 120),
        ("dep_alice", 3_333),
        ("harvest", 611),
        ("wd_alice", 9_999),
        ("harvest", 97),
        ("wd_bob", 15_001),
    ];
    for (kind, amount) in actions {
        match kind {
            "dep_alice" => {
                let _ = deposit_for(&f, &alice, amount);
            }
            "dep_bob" => {
                let _ = deposit_for(&f, &bob, amount);
            }
            "harvest" => {
                let _ = f.client.harvest(&f.strategy, &amount);
            }
            _ => {
                let who = if kind == "wd_alice" { &alice } else { &bob };
                let balance = f.client.share_balance(who);
                if balance > 0 {
                    f.client.withdraw(who, &amount.min(balance));
                }
            }
        }
        let rate = if f.client.total_shares() > 0 {
            // Live pool: the ratchet must hold.
            f.client.exchange_rate()
        } else {
            // Pool fully exited: the sentinel 1:1 reset is by design, not a
            // regression — freeze comparison at the last live rate.
            prev_rate
        };
        assert_rate_holds(prev_rate, rate);
        prev_rate = rate;
    }
    assert!(prev_rate >= RATE_SCALE);
}

/// A sub-unit-rate pool makes a 1-stroop deposit mint floor(1·S/S') = 0
/// shares while still adding its asset — rounding dust can only push the
/// rate UP, never down.
#[test]
fn dust_deposit_never_lowers_the_rate() {
    let f = vault_setup();
    let whale = Address::generate(&f.env);
    let dust = Address::generate(&f.env);
    f.token_admin.mint(&whale, &1_000_000);
    f.token_admin.mint(&dust, &10);

    deposit_for(&f, &whale, 1_000);
    // Skew the pool above 1:1 (rate = 2) so fresh shares cost 2 assets.
    f.client.harvest(&f.strategy, &1_000);

    let before = f.client.exchange_rate();
    let minted = deposit_for(&f, &dust, 1);
    assert_eq!(minted, 0); // floor(1 × 1_000 / 2_000)
    assert_rate_holds(before, f.client.exchange_rate());
}

/// Zero / negative amounts and over-spends must fail closed. Error
/// discriminants surface as `Error(Contract, #N)` panics (repo convention).
#[test]
#[should_panic(expected = "3")] // YieldError::InvalidAmount
fn zero_deposit_panics() {
    let f = vault_setup();
    let alice = Address::generate(&f.env);
    deposit_for(&f, &alice, 0);
}

#[test]
#[should_panic(expected = "4")] // YieldError::InvalidYield
fn zero_harvest_panics() {
    let f = vault_setup();
    f.client.harvest(&f.strategy, &0);
}

#[test]
#[should_panic(expected = "5")] // YieldError::InsufficientShares
fn overdraft_withdrawal_panics() {
    let f = vault_setup();
    let alice = Address::generate(&f.env);
    f.token_admin.mint(&alice, &1_000);
    deposit_for(&f, &alice, 1_000);
    f.client.withdraw(&alice, &1_001);
}

// NOTE: a dedicated zero-payout-withdrawal case is unnecessary — the share
// rate starts at 1:1 and can only ratchet up, so while any shares exist
// their floor payout is ≥ 1 stroop; the defensive branch stays in the
// contract for future pool shapes.

#[test]
#[should_panic(expected = "1")] // YieldError::AlreadyInitialized
fn double_initialization_panics() {
    let f = vault_setup();
    f.client.initialize(&f.admin, &f.token.address);
}
/* --------------------- escrow integration tests ----------------------- */

#[test]
fn escrow_deploys_idle_reserves_and_recalls_for_settlements() {
    let f = escrow_with_yield_vault(10_000);

    // Nothing deployed yet: the whole balance sits in the liquid buffer.
    assert_eq!(f.client.deployed_to_vault(), 0);
    assert_eq!(f.client.liquid_reserve(), 10_000);

    // Deploy 6_000 idle reserves above the buffer into the yield strategy.
    let deployed = f.client.deploy_idle_to_vault(&6_000, &Vec::new(&f.env));
    assert_eq!(deployed, 6_000);
    assert_eq!(f.client.deployed_to_vault(), 6_000);
    assert_eq!(f.client.liquid_reserve(), 4_000);
    assert_eq!(f.vault_client.total_assets(), 6_000);
    assert_eq!(
        f.vault_client.share_balance(&f.client.address),
        6_000
    );

    // Yield accrues while funds are deployed (fund the strategy first so its
    // harvest transfer settles against a real balance)…
    let strategy = Address::generate(&f.env);
    f.token_admin.mint(&strategy, &1_000);
    f.vault_client.harvest(&strategy, &60);
    assert!(f.vault_client.exchange_rate() > RATE_SCALE);

    // …and an instant settlement draw recalls ≥ the required amount even at
    // the higher rate (the share requirement rounds up).
    let recalled = f.client.recall_from_vault(&2_500);
    assert!(recalled >= 2_500);
    assert_eq!(f.client.deployed_to_vault(), 6_000 - recalled);
    assert_eq!(f.client.liquid_reserve(), 4_000 + recalled);

    // Recall with 0 drains the escrow's ENTIRE share position, so every
    // stroop — original deployment AND accrued yield — rides home.
    let rest = f.client.recall_from_vault(&0);
    assert!(rest > 0);
    assert_eq!(f.client.deployed_to_vault(), 0);
    assert_eq!(f.vault_client.total_shares(), 0);
    assert_eq!(f.vault_client.total_assets(), 0);
    // Escrow ends whole: original balance + the full harvested yield.
    assert_eq!(f.client.liquid_reserve(), 10_000 + 60);
}

#[test]
fn recall_with_nothing_deployed_is_a_no_op() {
    let f = escrow_with_yield_vault(5_000);
    assert_eq!(f.client.recall_from_vault(&1_234), 0);
    assert_eq!(f.client.deployed_to_vault(), 0);
    assert_eq!(f.client.liquid_reserve(), 5_000);
}

#[test]
#[should_panic(expected = "2")] // Error::NotInitialized — no vault configured
fn recall_before_set_yield_vault_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(
        &Address::generate(&env),
        &sac.address(),
        &0u32,
        &ArbitratorSet {
            keys: Vec::new(&env),
            threshold_epoch1: 1,
            threshold_epoch2: 2,
            t1_ledgers: 100,
            t2_ledgers: 200,
        },
    );
    client.recall_from_vault(&100);
}

#[test]
#[should_panic(expected = "8")] // Error::InvalidAmount
fn deploy_rejects_non_positive_amounts() {
    let f = escrow_with_yield_vault(1_000);
    f.client
        .deploy_idle_to_vault(&0, &Vec::new(&f.env));
}



