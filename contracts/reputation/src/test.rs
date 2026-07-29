use super::*;
use soroban_sdk::testutils::Address as _;

#[contract]
pub struct MockEscrowContract;

#[contractimpl]
impl MockEscrowContract {
    pub fn get_trade_count(env: Env) -> u32 {
        let mut count = 0u32;
        for i in 1..=200 {
            let idx_bytes = (i as u128).to_le_bytes();
            let mut full = [0u8; 32];
            full[..16].copy_from_slice(&idx_bytes);
            let key = RepDataKey::Trade(BytesN::from_array(&env, &full));
            if env.storage().persistent().has(&key) {
                count = i;
            } else {
                break;
            }
        }
        count
    }

    pub fn get_trade_by_index(env: Env, index: u32) -> Option<BytesN<32>> {
        let idx_bytes = (index as u128).to_le_bytes();
        let mut full = [0u8; 32];
        full[..16].copy_from_slice(&idx_bytes);
        let key = RepDataKey::Trade(BytesN::from_array(&env, &full));
        if env.storage().persistent().has(&key) {
            Some(BytesN::from_array(&env, &full))
        } else {
            None
        }
    }

    pub fn get_trade(env: Env, id: BytesN<32>) -> Option<TradeState> {
        let key = RepDataKey::Trade(id);
        env.storage().persistent().get(&key)
    }
}

fn setup_env() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.budget().reset_unlimited();
    let admin = Address::generate(&env);
    let escrow = env.register(MockEscrowContract, ());
    (env, admin, escrow)
}

fn setup_contract<'a>(
    env: &'a Env,
    admin: &'a Address,
    escrow: &'a Address,
) -> ReputationContractClient<'a> {
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(env, &contract_id);
    client.initialize(admin, escrow);
    client
}

fn setup_escrow_trades(env: &Env, escrow: &Address, trades: &[(Address, Address, TradeStatus)]) {
    for (i, (seller, buyer, status)) in trades.iter().enumerate() {
        let idx = i as u32 + 1;
        let id_bytes = (idx as u128).to_le_bytes();
        let mut full = [0u8; 32];
        full[..16].copy_from_slice(&id_bytes);

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

    let trades = [
        (seller.clone(), buyer1.clone(), TradeStatus::Released),
        (seller.clone(), buyer2.clone(), TradeStatus::Released),
        (seller.clone(), buyer3.clone(), TradeStatus::Released),
    ];

    setup_escrow_trades(&env, &escrow, &trades);

    let client = setup_contract(&env, &_admin, &escrow);
    let score = client.compute_score(&seller);
    assert!(
        score > 0,
        "score should be > 0 for a seller with completed trades"
    );
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

    let trades = [
        (seller.clone(), seller.clone(), TradeStatus::Released),
        (seller.clone(), seller.clone(), TradeStatus::Released),
        (seller.clone(), seller.clone(), TradeStatus::Released),
    ];

    setup_escrow_trades(&env, &escrow, &trades);

    let client = setup_contract(&env, &_admin, &escrow);
    let score = client.compute_score(&seller);
    assert_eq!(
        score, 0,
        "self-trades should be excluded, score should be 0"
    );
}

#[test]
fn test_sybil_self_trading() {
    let (env, _admin, escrow) = setup_env();
    let addr = Address::generate(&env);
    let buyer = Address::generate(&env);

    extern crate std;
    let mut trades_vec = std::vec::Vec::new();
    for _ in 0..20 {
        trades_vec.push((addr.clone(), addr.clone(), TradeStatus::Released));
    }
    trades_vec.push((addr.clone(), buyer, TradeStatus::Released));

    setup_escrow_trades(&env, &escrow, &trades_vec);

    let client = setup_contract(&env, &_admin, &escrow);
    let score = client.compute_score(&addr);
    assert!(
        score > 0,
        "should have non-zero score from the 1 real trade"
    );
    assert!(
        score <= 1000,
        "self-trades should not inflate the score unreasonably"
    );
}

#[test]
fn test_dispute_penalty() {
    let (env, _admin, escrow) = setup_env();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let trades = [
        (seller.clone(), buyer.clone(), TradeStatus::Released),
        (seller.clone(), buyer.clone(), TradeStatus::Disputed),
    ];

    setup_escrow_trades(&env, &escrow, &trades);

    let client = setup_contract(&env, &_admin, &escrow);
    let score = client.compute_score(&seller);
    assert!(
        score < 1000,
        "dispute penalty should reduce score below max 1000"
    );
}

#[test]
fn test_mixed_outcomes() {
    let (env, _admin, escrow) = setup_env();
    let seller = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    let b3 = Address::generate(&env);
    let b4 = Address::generate(&env);

    let trades = [
        (seller.clone(), b1, TradeStatus::Released),
        (seller.clone(), b2, TradeStatus::Refunded),
        (seller.clone(), b3, TradeStatus::Disputed),
        (seller.clone(), b4, TradeStatus::Released),
    ];

    setup_escrow_trades(&env, &escrow, &trades);

    let client = setup_contract(&env, &_admin, &escrow);
    let score = client.compute_score(&seller);
    assert!(score > 0 && score <= 1000);
}

#[test]
fn test_score_breakdown() {
    let (env, _admin, escrow) = setup_env();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let trades = [(seller.clone(), buyer.clone(), TradeStatus::Released)];
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

    let trades = [(seller.clone(), buyer.clone(), TradeStatus::Released)];
    setup_escrow_trades(&env, &escrow, &trades);

    let client = setup_contract(&env, &_admin, &escrow);
    let score1 = client.compute_score(&seller);
    let score2 = client.get_score(&seller);
    assert_eq!(score2, Some(score1));
}

fn generate_zk_rep_proof(
    env: &Env,
    identity_root: &BytesN<32>,
    min_reputation: u32,
    epoch_id: u64,
    nullifier_hash: &BytesN<32>,
) -> Bytes {
    let mut input = Bytes::new(env);
    input.append(&identity_root.clone().into());
    input.append(&Bytes::from_slice(env, &min_reputation.to_be_bytes()));
    input.append(&Bytes::from_slice(env, &epoch_id.to_be_bytes()));
    input.append(&nullifier_hash.clone().into());
    input.append(&Bytes::from_slice(env, b"zk_provider_rep_v1"));

    let expected_hash = env.crypto().sha256(&input);
    let mut proof = Bytes::new(env);
    proof.append(&expected_hash.into());
    proof.append(&Bytes::from_slice(env, &[0x99u8; 64]));
    proof
}

#[test]
fn test_zk_provider_reputation_verification_happy_path() {
    let (env, admin, escrow) = setup_env();
    let client = setup_contract(&env, &admin, &escrow);
    let provider = Address::generate(&env);

    let identity_root = BytesN::from_array(&env, &[0x11u8; 32]);
    client.register_identity_root(&admin, &identity_root);
    assert!(client.is_identity_root_valid(&identity_root));

    let min_rep: u32 = 750;
    let epoch_id: u64 = 20260726;

    let sk = BytesN::from_array(&env, &[0x77u8; 32]);
    let mut null_input = Bytes::new(&env);
    null_input.append(&sk.into());
    null_input.append(&Bytes::from_slice(&env, &epoch_id.to_be_bytes()));
    let nullifier_hash = env.crypto().sha256(&null_input).to_bytes();

    let proof = generate_zk_rep_proof(&env, &identity_root, min_rep, epoch_id, &nullifier_hash);

    assert!(!client.is_nullifier_spent(&nullifier_hash));

    let verified = client.verify_provider_reputation(
        &provider,
        &identity_root,
        &min_rep,
        &epoch_id,
        &nullifier_hash,
        &proof,
    );
    assert_eq!(verified, true);
    assert!(client.is_nullifier_spent(&nullifier_hash));
}

#[test]
fn test_zk_provider_reputation_reused_nullifier_rejected() {
    let (env, admin, escrow) = setup_env();
    let client = setup_contract(&env, &admin, &escrow);
    let provider = Address::generate(&env);

    let identity_root = BytesN::from_array(&env, &[0x22u8; 32]);
    client.register_identity_root(&admin, &identity_root);

    let min_rep: u32 = 500;
    let epoch_id: u64 = 20260726;
    let nullifier_hash = BytesN::from_array(&env, &[0x33u8; 32]);
    let proof = generate_zk_rep_proof(&env, &identity_root, min_rep, epoch_id, &nullifier_hash);

    // First claim succeeds
    let res1 = client.verify_provider_reputation(
        &provider,
        &identity_root,
        &min_rep,
        &epoch_id,
        &nullifier_hash,
        &proof,
    );
    assert_eq!(res1, true);

    // Second claim with same nullifier fails
    let res2 = client.try_verify_provider_reputation(
        &provider,
        &identity_root,
        &min_rep,
        &epoch_id,
        &nullifier_hash,
        &proof,
    );
    assert_eq!(res2, Err(Ok(Error::NullifierAlreadyUsed)));
}

#[test]
fn test_zk_provider_reputation_unregistered_root_rejected() {
    let (env, admin, escrow) = setup_env();
    let client = setup_contract(&env, &admin, &escrow);
    let provider = Address::generate(&env);

    let unreg_root = BytesN::from_array(&env, &[0x44u8; 32]);
    let nullifier_hash = BytesN::from_array(&env, &[0x55u8; 32]);
    let proof = generate_zk_rep_proof(&env, &unreg_root, 500, 20260726, &nullifier_hash);

    let res = client.try_verify_provider_reputation(
        &provider,
        &unreg_root,
        &500,
        &20260726,
        &nullifier_hash,
        &proof,
    );
    assert_eq!(res, Err(Ok(Error::InvalidIdentityRoot)));
}

#[test]
fn test_zk_provider_reputation_invalid_proof_rejected() {
    let (env, admin, escrow) = setup_env();
    let client = setup_contract(&env, &admin, &escrow);
    let provider = Address::generate(&env);

    let identity_root = BytesN::from_array(&env, &[0x66u8; 32]);
    client.register_identity_root(&admin, &identity_root);

    let nullifier_hash = BytesN::from_array(&env, &[0x77u8; 32]);
    let bad_proof = Bytes::from_slice(&env, &[0x00u8; 64]);

    let res = client.try_verify_provider_reputation(
        &provider,
        &identity_root,
        &500,
        &20260726,
        &nullifier_hash,
        &bad_proof,
    );
    assert_eq!(res, Err(Ok(Error::InvalidProof)));
}
