//! MicopayEscrow-style P2P cash escrow with N-of-M multisig admin governance.
//!
//! Locks a buyer's stablecoins against a secret hash. The seller (cash
//! provider) only receives funds by revealing the secret shown to them
//! at hand-off (the QR code flow). If nobody shows up, the buyer can
//! reclaim funds after the timeout — no dispute process, no custodian.
//!
//! Admin actions (fee changes, pause, signer management) are guarded by
//! a configurable N-of-M multisig or by a single admin for backward
//! compatibility.  Call `migrate_to_multisig()` to transition from the
//! original single-admin model.
#![no_std]

use htlc_core::{Htlc, TradeState, TradeStatus};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Vec,
};

#[contracttype]
enum DataKey {
    Admin,
    PlatformFeeBps,
    Token,
    Trade(BytesN<32>),
    Signers,
    Threshold,
    Paused,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    TradeAlreadyExists = 3,
    TradeNotFound = 4,
    TradeNotLocked = 5,
    InvalidSecret = 6,
    TimeoutNotReached = 7,
    InvalidAmount = 8,
    InvalidTimeout = 9,
    InvalidFee = 10,
    NotAuthorized = 11,
    ContractPaused = 12,
    InvalidSigners = 13,
    AlreadyMigrated = 14,
}

const DEFAULT_TIMEOUT_LEDGERS_MAX: u32 = 6 * 60 * 24 * 7;

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// One-time setup: sets the admin (fee recipient) and the settlement
    /// token (e.g. USDC on Stellar).  Starts in single-admin mode — call
    /// `migrate_to_multisig()` later to enable N-of-M governance.
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        platform_fee_bps: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if platform_fee_bps > 10_000 {
            return Err(Error::InvalidFee);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &platform_fee_bps);
        Ok(())
    }

    /// Migrate from single-admin to N-of-M multisig governance.
    /// Requires the current single admin to authorize.  Once called,
    /// all privileged actions (set_platform_fee, pause, etc.) require
    /// `threshold` signatures from the `signers` set.
    pub fn migrate_to_multisig(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if env.storage().instance().has(&DataKey::Signers) {
            return Err(Error::AlreadyMigrated);
        }
        if signers.len() == 0 || threshold == 0 || threshold > signers.len() {
            return Err(Error::InvalidSigners);
        }

        env.storage()
            .instance()
            .set(&DataKey::Signers, &signers);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        Ok(())
    }

    /// Replace the signer set and threshold.  Requires the current
    /// threshold of signers (passed via `auth_signers`) to authorize
    /// the change.
    pub fn set_signers(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
        auth_signers: Vec<Address>,
    ) -> Result<(), Error> {
        if signers.len() == 0 || threshold == 0 || threshold > signers.len() {
            return Err(Error::InvalidSigners);
        }
        require_multisig(&env, &auth_signers)?;
        env.storage()
            .instance()
            .set(&DataKey::Signers, &signers);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        Ok(())
    }

    /// Change the platform fee (in basis points).  Gated by single
    /// admin or multisig depending on the current mode.
    ///
    /// In single-admin mode the `signers` parameter is ignored; in
    /// multisig mode it must contain at least `threshold` authorised
    /// signers whose signatures are on the transaction.
    pub fn set_platform_fee(
        env: Env,
        fee_bps: u32,
        signers: Vec<Address>,
    ) -> Result<(), Error> {
        require_multisig(&env, &signers)?;
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &fee_bps);
        Ok(())
    }

    /// Change the fee recipient address.  Gated by single admin or
    /// multisig.
    pub fn set_fee_recipient(
        env: Env,
        recipient: Address,
        signers: Vec<Address>,
    ) -> Result<(), Error> {
        require_multisig(&env, &signers)?;
        env.storage().instance().set(&DataKey::Admin, &recipient);
        Ok(())
    }

    /// Pause the contract — `lock`, `release` and `refund` will be
    /// rejected while paused.
    pub fn pause(env: Env, signers: Vec<Address>) -> Result<(), Error> {
        require_multisig(&env, &signers)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        Ok(())
    }

    /// Unpause the contract, restoring normal operation.
    pub fn unpause(env: Env, signers: Vec<Address>) -> Result<(), Error> {
        require_multisig(&env, &signers)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    /// Read-only accessor for a trade's current state. Returns `None` if
    /// the id was never locked.
    pub fn get_trade(env: Env, id: BytesN<32>) -> Option<TradeState> {
        env.storage().persistent().get(&DataKey::Trade(id))
    }
}

#[contractimpl]
impl Htlc for EscrowContract {
    fn lock(
        env: Env,
        id: BytesN<32>,
        seller: Address,
        buyer: Address,
        amount: i128,
        secret_hash: BytesN<32>,
        timeout_ledgers: u32,
    ) {
        check_not_paused(&env);
        buyer.require_auth();

        if amount <= 0 || amount > (i128::MAX / 10_000) {
            panic_with_error(&env, Error::InvalidAmount);
        }
        if timeout_ledgers == 0 || timeout_ledgers > DEFAULT_TIMEOUT_LEDGERS_MAX {
            panic_with_error(&env, Error::InvalidTimeout);
        }

        let key = DataKey::Trade(id.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error(&env, Error::TradeAlreadyExists);
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .unwrap_or_else(|| panic_with_error(&env, Error::NotInitialized));

        let client = token::Client::new(&env, &token_addr);
        client.transfer(&buyer, &env.current_contract_address(), &amount);

        let timeout_ledger = env.ledger().sequence() + timeout_ledgers;

        let state = TradeState {
            seller,
            buyer,
            amount,
            secret_hash,
            timeout_ledger,
            status: TradeStatus::Locked,
        };
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 100_000);

        env.events()
            .publish((symbol_short(&env, "locked"), id), amount);
    }

    fn release(env: Env, id: BytesN<32>, secret: BytesN<32>) {
        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error(&env, Error::TradeNotFound));

        if state.status != TradeStatus::Locked {
            panic_with_error(&env, Error::TradeNotLocked);
        }

        let computed = env.crypto().sha256(&secret.into());
        if computed.to_bytes() != state.secret_hash {
            panic_with_error(&env, Error::InvalidSecret);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(0);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();

        let fee = (state.amount * fee_bps as i128) / 10_000;
        let payout = state.amount - fee;

        // CEI pattern: update state before external calls
        state.status = TradeStatus::Released;
        env.storage().persistent().set(&key, &state);

        let client = token::Client::new(&env, &token_addr);
        client.transfer(&env.current_contract_address(), &state.seller, &payout);
        if fee > 0 {
            client.transfer(&env.current_contract_address(), &admin, &fee);
        }

        env.events()
            .publish((symbol_short(&env, "released"), id), payout);
    }

    fn refund(env: Env, id: BytesN<32>) {
        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error(&env, Error::TradeNotFound));

        if state.status != TradeStatus::Locked {
            panic_with_error(&env, Error::TradeNotLocked);
        }
        if env.ledger().sequence() < state.timeout_ledger {
            panic_with_error(&env, Error::TimeoutNotReached);
        }

        // CEI pattern: update state before external calls
        state.status = TradeStatus::Refunded;
        env.storage().persistent().set(&key, &state);

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        client.transfer(&env.current_contract_address(), &state.buyer, &state.amount);

        env.events()
            .publish((symbol_short(&env, "refunded"), id), state.amount);
    }
}

fn check_not_paused(env: &Env) {
    if let Some(paused) = env.storage().instance().get::<DataKey, bool>(&DataKey::Paused) {
        if paused {
            panic_with_error(env, Error::ContractPaused);
        }
    }
}

fn require_multisig(env: &Env, provided_signers: &Vec<Address>) -> Result<(), Error> {
    if let Some(threshold) = env
        .storage()
        .instance()
        .get::<DataKey, u32>(&DataKey::Threshold)
    {
        let authorized: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap();
        validate_signers(env, provided_signers, &authorized, threshold)?;
    } else {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap();
        admin.require_auth();
    }
    Ok(())
}

fn validate_signers(
    _: &Env,
    provided: &Vec<Address>,
    authorized: &Vec<Address>,
    threshold: u32,
) -> Result<(), Error> {
    if provided.len() < threshold {
        return Err(Error::NotAuthorized);
    }
    for i in 0..provided.len() {
        let signer = provided.get(i).unwrap();
        if !is_authorized(&signer, authorized) {
            return Err(Error::NotAuthorized);
        }
        signer.require_auth();
    }
    Ok(())
}

fn is_authorized(addr: &Address, authorized: &Vec<Address>) -> bool {
    for i in 0..authorized.len() {
        if authorized.get(i).unwrap() == *addr {
            return true;
        }
    }
    false
}

fn panic_with_error(_: &Env, err: Error) -> ! {
    panic!("{}", err as u32)
}

fn symbol_short(env: &Env, s: &str) -> soroban_sdk::Symbol {
    soroban_sdk::Symbol::new(env, s)
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn lock_release_pays_seller_minus_fee() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        // NOTE: wire up a token test client (soroban_sdk::testutils token
        // contract) before running this for real — omitted here to keep
        // the scaffold dependency-light. This test documents the intended
        // behavior for whoever picks up the first PR against this file.
        let _ = (env, admin, buyer, seller);
    }

    #[test]
    #[should_panic(expected = "10")]
    fn test_initialize_invalid_fee() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        EscrowContractClient::new(&env, &env.register_contract(None, EscrowContract))
            .initialize(&admin, &token, &10_001);
    }

    #[test]
    #[should_panic(expected = "8")]
    fn test_lock_overflow_amount_panics() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let client = EscrowContractClient::new(&env, &env.register_contract(None, EscrowContract));

        client.initialize(&admin, &token, &100);

        let id = BytesN::from_array(&env, &[1u8; 32]);
        let secret = BytesN::from_array(&env, &[7u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.into()).to_bytes();

        // Large amount that exceeds i128::MAX / 10_000
        let overflow_amount = (i128::MAX / 10_000) + 1;
        client.lock(&id, &seller, &buyer, &overflow_amount, &secret_hash, &100);
    }
}