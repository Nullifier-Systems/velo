use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};

fn setup_env() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let escrow = Address::generate(&env);
    (env, admin, escrow)
}

fn setup_contract(env: &Env, admin: &Address, escrow: &Address) -> ReputationContractClient {
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(env, &contract_id);
    client.initialize(admin, escrow);
    client
}

fn setup_escrow_trades(
    env: &Env,
    escrow: &Address,
    trades: &[(Address, Address, TradeStatus)],
) {
    for (i, (seller, buyer, status)) in trades.iter().enumerate() {
        let idx = i as u32 + 1;
        let id_bytes = (idx as u128).to_le_bytes();
        let mut full = [0u8; 32];
        full[..16].copy_from_slice(&id_bytes);
        let id = BytesN::from_array(env, &full);

        // We cannot call lock() directly since it transfers tokens.
        // Instead, we write directly to the escrow contract's storage.
        let state = TradeState {
            seller: seller.clone(),
            buyer: buyer.clone(),
            amount: 100_000_000i128, // 10 USDC
            secret_hash: BytesN::from_array(env, &[idx as u8; 32]),
            timeout_ledger: 1000,
            status: status.clone(),
        };
        env.as_contract(escrow, || {
            env.storage().persistent().set(
                &super::RepDataKey::Trade(BytesN::from_array(env, &full)),
                &state,
            );
        });
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn test_initialize() {
    let (env, admin, escrow) = setup_env();
    let client = setup_contract(&env, &admin, &escrow);
    let score = client.compute_score(&admin);
    assert_eq!(score, 0);
}

#[test]
fn test_score_happy_path() {
    let (env, _admin, escrow) = setup_env();
    let seller = Address::generate(&env);
    let buyer1 = Address::generate(&env);
    let buyer2 = Address::generate(&env);
    let buyer3 = Address::generate(&env);

    let trades = vec![
        (&env, (seller.clone(), buyer1.clone(), TradeStatus::Released)),
        (&env, (seller.clone(), buyer2.clone(), TradeStatus::Released)),
        (&env, (seller.clone(), buyer3.clone(), TradeStatus::Released)),
    ];

    setup_escrow_trades(&env, &escrow, &trades);

    let client = setup_contract(&env, &_admin, &escrow);
    let score = client.compute_score(&seller);
    assert!(score > 0, "score should be > 0 for a seller with completed trades");
    assert!(score <= 1000, "score should be <= 1000");
}

#[test]
fn test_score_zero_for_no_trades() {
    let (env, admin, escrow) = setup_env();
    let client = setup_contract(&env, &admin, &escrow);
    let score = client.compute_score(&admin);
    assert_eq!(score, 0);
}

#[test]
fn test_self_trades_excluded() {
    let (env, _admin, escrow) = setup_env();
    let seller = Address::generate(&env);

    // Only self-trades (seller == buyer)
    let trades = vec![
        (&env, (seller.clone(), seller.clone(), TradeStatus::Released)),
        (&env, (seller.clone(), seller.clone(), TradeStatus::Released)),
        (&env, (seller.clone(), seller.clone(), TradeStatus::Released)),
    ];

    setup_escrow_trades(&env, &escrow, &trades);

    let client = setup_contract(&env, &_admin, &escrow);
    let score = client.compute_score(&seller);
    assert_eq!(score, 0, "self-trades should be excluded, score should be 0");
}

#[test]
fn test_sybil_self_trading() {
    let (env, _admin, escrow) = setup_env();
    let addr = Address::generate(&env);

    // 100 self-trades (seller == buyer)
    let mut trades_vec = Vec::new(&env);
    for _ in 0..100 {
        trades_vec.push_back((addr.clone(), addr.clone(), TradeStatus::Released));
    }

    setup_escrow_trades(&env, &escrow, &trades_vec);

    let buyer = Address::generate(&env);
    let trades2 = vec![
        (&env, (addr.clone(), buyer, TradeStatus::Released)),
    ];
    setup_escrow_trades(&env, &escrow, &trades2);

    let client = setup_contract(&env, &_admin, &escrow);
    let score = client.compute_score(&addr);
    // Score should be based only on the 1 real trade, not the 100 self-trades
    assert!(score > 0, "should have non-zero score from the 1 real trade");
    assert!(score <= 500, "self-trades should not inflate the score unreasonably");
}

#[test]
fn test_dispute_penalty() {
    let (env, _admin, escrow) = setup_env();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    // Half successful, half disputed
    let trades = vec![
        (&env, (seller.clone(), buyer.clone(), TradeStatus::Released)),
        (&env, (seller.clone(), buyer.clone(), TradeStatus::Disputed)),
    ];

    setup_escrow_trades(&env, &escrow, &trades);

    let client = setup_contract(&env, &_admin, &escrow);
    let score = client.compute_score(&seller);
    assert!(score <= 500, "dispute penalty should reduce score");
}

#[test]
fn test_mixed_outcomes() {
    let (env, _admin, escrow) = setup_env();
    let seller = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    let b3 = Address::generate(&env);
    let b4 = Address::generate(&env);

    let trades = vec![
        (&env, (seller.clone(), b1, TradeStatus::Released)),
        (&env, (seller.clone(), b2, TradeStatus::Refunded)),
        (&env, (seller.clone(), b3, TradeStatus::Disputed)),
        (&env, (seller.clone(), b4, TradeStatus::Released)),
    ];

    setup_escrow_trades(&env, &escrow, &trades);

    let client = setup_contract(&env, &_admin, &escrow);
    let score = client.compute_score(&seller);
    // 2 completed out of 3 eligible (excludes refunded) = 66% completion
    // 1 disputed out of 3 eligible = 33% dispute rate
    // volume bonus, diversity bonus from 3 counterparties
    assert!(score > 0 && score <= 1000);
}

#[test]
fn test_score_breakdown() {
    let (env, _admin, escrow) = setup_env();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let trades = vec![
        (&env, (seller.clone(), buyer.clone(), TradeStatus::Released)),
    ];
    setup_escrow_trades(&env, &escrow, &trades);

    let client = setup_contract(&env, &_admin, &escrow);
    let breakdown = client.get_score_breakdown(&seller);
    assert!(breakdown.score > 0);
}

#[test]
fn test_cached_score() {
    let (env, _admin, escrow) = setup_env();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let trades = vec![
        (&env, (seller.clone(), buyer.clone(), TradeStatus::Released)),
    ];
    setup_escrow_trades(&env, &escrow, &trades);

    let client = setup_contract(&env, &_admin, &escrow);
    let score1 = client.compute_score(&seller);
    let score2 = client.get_score(&seller);
    assert_eq!(score2, Some(score1));
}
