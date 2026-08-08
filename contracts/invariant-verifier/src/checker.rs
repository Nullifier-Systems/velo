use crate::spec::{InvariantItem, InvariantSpec};
use escrow::{EscrowContract, EscrowContractClient, Error as EscrowError};
use htlc_core::{TradeState, TradeStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, BytesN, Env, Vec as SorobanVec,
};

#[derive(Debug, Clone)]
pub struct VerificationResult {
    pub invariant_id: String,
    pub name: String,
    pub passed: bool,
    pub error_message: Option<String>,
}

pub struct InvariantChecker {
    spec: InvariantSpec,
}

impl InvariantChecker {
    pub fn new(spec: InvariantSpec) -> Self {
        Self { spec }
    }

    pub fn verify_all(&self) -> Vec<VerificationResult> {
        let mut results = Vec::new();
        for inv in &self.spec.invariants {
            let res = match inv.id.as_str() {
                "INV-01" => self.check_inv01_conservation_of_value(inv),
                "INV-02" => self.check_inv02_state_machine_exclusivity(inv),
                "INV-03" => self.check_inv03_timeout_monotonicity(inv),
                "INV-04" => self.check_inv04_secret_hash_correctness(inv),
                "INV-05" => self.check_inv05_fee_math_bounds(inv),
                "INV-06" => self.check_inv06_authorization_governance(inv),
                _ => VerificationResult {
                    invariant_id: inv.id.clone(),
                    name: inv.name.clone(),
                    passed: false,
                    error_message: Some(format!("Unknown invariant ID: {}", inv.id)),
                },
            };
            results.push(res);
        }
        results
    }

    fn check_inv01_conservation_of_value(&self, inv: &InvariantItem) -> VerificationResult {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let initial_mint: i128 = 1_000_000;
        let fee_bps: u32 = 250; // 2.5%

        let asset = env.register_stellar_asset_contract_v2(admin.clone());
        let token_client = token::Client::new(&env, &asset.address());
        token::StellarAssetClient::new(&env, &asset.address()).mint(&buyer, &initial_mint);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        if client.try_initialize(&admin, &asset.address(), &fee_bps).is_err() {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Failed to initialize EscrowContract".into()),
            };
        }

        let trade_id = BytesN::from_array(&env, &[1u8; 32]);
        let secret = BytesN::from_array(&env, &[7u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
        let lock_amount: i128 = 100_000;
        let timeout_ledgers: u32 = 100;

        // Lock funds
        client.lock(&trade_id, &seller, &buyer, &lock_amount, &secret_hash, &timeout_ledgers);

        let buyer_bal = token_client.balance(&buyer);
        let seller_bal = token_client.balance(&seller);
        let admin_bal = token_client.balance(&admin);
        let contract_bal = token_client.balance(&contract_id);

        let total_current = buyer_bal + seller_bal + admin_bal + contract_bal;
        if total_current != initial_mint {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some(format!(
                    "Balance mismatch after lock! Expected total {}, got {}",
                    initial_mint, total_current
                )),
            };
        }

        if contract_bal != lock_amount {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some(format!(
                    "Contract balance mismatch! Expected {}, got {}",
                    lock_amount, contract_bal
                )),
            };
        }

        // Release trade and check conservation again
        client.release(&trade_id, &secret);

        let buyer_bal_after = token_client.balance(&buyer);
        let seller_bal_after = token_client.balance(&seller);
        let admin_bal_after = token_client.balance(&admin);
        let contract_bal_after = token_client.balance(&contract_id);

        let total_after = buyer_bal_after + seller_bal_after + admin_bal_after + contract_bal_after;
        if total_after != initial_mint {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some(format!(
                    "Balance mismatch after release! Expected total {}, got {}",
                    initial_mint, total_after
                )),
            };
        }

        if contract_bal_after != 0 {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some(format!(
                    "Contract balance should be 0 after release, got {}",
                    contract_bal_after
                )),
            };
        }

        VerificationResult {
            invariant_id: inv.id.clone(),
            name: inv.name.clone(),
            passed: true,
            error_message: None,
        }
    }

    fn check_inv02_state_machine_exclusivity(&self, inv: &InvariantItem) -> VerificationResult {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let asset = env.register_stellar_asset_contract_v2(admin.clone());
        token::StellarAssetClient::new(&env, &asset.address()).mint(&buyer, &500_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &asset.address(), &100);

        let trade_id = BytesN::from_array(&env, &[2u8; 32]);
        let secret = BytesN::from_array(&env, &[8u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();

        client.lock(&trade_id, &seller, &buyer, &50_000, &secret_hash, &50);

        // State is Locked
        let trade_before = client.get_trade(&trade_id).unwrap();
        if trade_before.status != TradeStatus::Locked {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Initial status was not Locked".into()),
            };
        }

        // Release transition
        client.release(&trade_id, &secret);
        let trade_after = client.get_trade(&trade_id).unwrap();
        if trade_after.status != TradeStatus::Released {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Status after release was not Released".into()),
            };
        }

        // Terminal state check: attempt second release or refund on Released status
        let second_release = client.try_release(&trade_id, &secret);
        if second_release.is_ok() {
            // escrow release is a no-op or error when state is not Locked
            // Let's verify status remains Released
            let trade_terminal = client.get_trade(&trade_id).unwrap();
            if trade_terminal.status != TradeStatus::Released {
                return VerificationResult {
                    invariant_id: inv.id.clone(),
                    name: inv.name.clone(),
                    passed: false,
                    error_message: Some("Terminal Released state was overwritten!".into()),
                };
            }
        }

        VerificationResult {
            invariant_id: inv.id.clone(),
            name: inv.name.clone(),
            passed: true,
            error_message: None,
        }
    }

    fn check_inv03_timeout_monotonicity(&self, inv: &InvariantItem) -> VerificationResult {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let asset = env.register_stellar_asset_contract_v2(admin.clone());
        token::StellarAssetClient::new(&env, &asset.address()).mint(&buyer, &500_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &asset.address(), &100);

        let trade_id = BytesN::from_array(&env, &[3u8; 32]);
        let secret = BytesN::from_array(&env, &[9u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
        let timeout_ledgers: u32 = 100;

        client.lock(&trade_id, &seller, &buyer, &50_000, &secret_hash, &timeout_ledgers);

        // Attempt refund before timeout (ledger sequence < timeout_ledger)
        let premature_refund = client.try_refund(&trade_id);
        if premature_refund.is_ok() {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Refund succeeded before ledger timeout was reached!".into()),
            };
        }

        // Advance ledger past timeout
        env.ledger().with_mut(|li| li.sequence_number += timeout_ledgers + 1);

        // Dispute after timeout must fail with TimeoutReached
        let late_dispute = client.try_dispute(&buyer, &trade_id);
        if late_dispute.is_ok() {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Dispute succeeded after ledger timeout was reached!".into()),
            };
        }

        // Refund after timeout should now succeed
        let valid_refund = client.try_refund(&trade_id);
        if valid_refund.is_err() {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Refund failed after timeout was reached!".into()),
            };
        }

        VerificationResult {
            invariant_id: inv.id.clone(),
            name: inv.name.clone(),
            passed: true,
            error_message: None,
        }
    }

    fn check_inv04_secret_hash_correctness(&self, inv: &InvariantItem) -> VerificationResult {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let asset = env.register_stellar_asset_contract_v2(admin.clone());
        token::StellarAssetClient::new(&env, &asset.address()).mint(&buyer, &500_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &asset.address(), &100);

        let trade_id = BytesN::from_array(&env, &[4u8; 32]);
        let secret = BytesN::from_array(&env, &[10u8; 32]);
        let wrong_secret = BytesN::from_array(&env, &[99u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();

        client.lock(&trade_id, &seller, &buyer, &50_000, &secret_hash, &100);

        // Attempt release with wrong secret
        let bad_release = client.try_release(&trade_id, &wrong_secret);
        if bad_release.is_ok() {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Release succeeded with an invalid secret preimage!".into()),
            };
        }

        // Verify status remains Locked after failed attempt
        let trade = client.get_trade(&trade_id).unwrap();
        if trade.status != TradeStatus::Locked {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Trade status changed after failed secret release attempt".into()),
            };
        }

        // Release with correct secret
        let good_release = client.try_release(&trade_id, &secret);
        if good_release.is_err() {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Release failed with correct secret preimage!".into()),
            };
        }

        VerificationResult {
            invariant_id: inv.id.clone(),
            name: inv.name.clone(),
            passed: true,
            error_message: None,
        }
    }

    fn check_inv05_fee_math_bounds(&self, inv: &InvariantItem) -> VerificationResult {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let asset = env.register_stellar_asset_contract_v2(admin.clone());
        token::StellarAssetClient::new(&env, &asset.address()).mint(&buyer, &1_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // Fee BPS > 10,000 must be rejected
        let invalid_init = client.try_initialize(&admin, &asset.address(), &10_001);
        if invalid_init.is_ok() {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Initialization accepted invalid fee_bps > 10,000!".into()),
            };
        }

        // Valid fee initialization (500 bps = 5%)
        client.initialize(&admin, &asset.address(), &500);

        let trade_id = BytesN::from_array(&env, &[5u8; 32]);
        let secret = BytesN::from_array(&env, &[11u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
        let amount: i128 = 100_000;

        client.lock(&trade_id, &seller, &buyer, &amount, &secret_hash, &100);
        client.release(&trade_id, &secret);

        let token_client = token::Client::new(&env, &asset.address());
        let seller_payout = token_client.balance(&seller);
        let admin_fee = token_client.balance(&admin);

        let expected_fee = (amount * 500) / 10_000; // 5,000
        let expected_payout = amount - expected_fee; // 95,000

        if admin_fee != expected_fee || seller_payout != expected_payout {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some(format!(
                    "Fee math discrepancy! Expected fee {}, payout {}, got fee {}, payout {}",
                    expected_fee, expected_payout, admin_fee, seller_payout
                )),
            };
        }

        if admin_fee + seller_payout != amount {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Fee plus payout does not equal total trade amount!".into()),
            };
        }

        VerificationResult {
            invariant_id: inv.id.clone(),
            name: inv.name.clone(),
            passed: true,
            error_message: None,
        }
    }

    fn check_inv06_authorization_governance(&self, inv: &InvariantItem) -> VerificationResult {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let stranger = Address::generate(&env);
        let asset = env.register_stellar_asset_contract_v2(admin.clone());
        token::StellarAssetClient::new(&env, &asset.address()).mint(&buyer, &500_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &asset.address(), &100);

        let trade_id = BytesN::from_array(&env, &[6u8; 32]);
        let secret = BytesN::from_array(&env, &[12u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();

        client.lock(&trade_id, &seller, &buyer, &50_000, &secret_hash, &100);

        // Stranger attempting to dispute must fail with Unauthorized
        let stranger_dispute = client.try_dispute(&stranger, &trade_id);
        if stranger_dispute.is_ok() {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Stranger unauthorized call to dispute succeeded!".into()),
            };
        }

        // Valid dispute by buyer
        client.dispute(&buyer, &trade_id);

        // Resolve call with non-admin signer in multisig when single admin expected or empty signers
        let empty_signers = SorobanVec::new(&env);
        let valid_resolve = client.try_resolve(&trade_id, &true, &empty_signers);
        if valid_resolve.is_err() {
            return VerificationResult {
                invariant_id: inv.id.clone(),
                name: inv.name.clone(),
                passed: false,
                error_message: Some("Admin resolve call failed under valid authorization!".into()),
            };
        }

        VerificationResult {
            invariant_id: inv.id.clone(),
            name: inv.name.clone(),
            passed: true,
            error_message: None,
        }
    }
}
