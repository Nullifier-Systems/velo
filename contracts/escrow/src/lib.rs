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
    Unauthorized = 10,
    TimeoutReached = 11,
    TradeNotDisputed = 12,
    InvalidFee = 13,
    NotAuthorized = 14,
    ContractPaused = 15,
    InvalidSigners = 16,
    AlreadyMigrated = 17,
    DuplicateSigner = 18,
    BatchTooLarge = 19,
}

const DEFAULT_TIMEOUT_LEDGERS_MAX: u32 = 6 * 60 * 24 * 7;

/// Caps how many trades a single `batch_release()` invocation may touch.
/// Soroban's per-invocation compute budget grows with each additional
/// token transfer + storage write, so this bounds worst-case resource
/// usage rather than relying on the caller to behave. See
/// docs/provider-payout-batching.md for the reasoning behind this figure.
const MAX_BATCH_SIZE: u32 = 25;

/// One entry in a `batch_release()` call: the trade to release and the
/// secret that unlocks it. Mirrors the arguments `release()` already takes,
/// just packaged so many can travel in one Soroban invocation.
#[derive(Clone)]
#[contracttype]
pub struct BatchReleaseItem {
    pub id: BytesN<32>,
    pub secret: BytesN<32>,
}

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

    /// Read-only accessor for a trade's current state. Returns `None` if the id
    /// was never locked.
    pub fn get_trade(env: Env, id: BytesN<32>) -> Option<TradeState> {
        env.storage().persistent().get(&DataKey::Trade(id))
    }

    /// Flag a trade as disputed before its timeout. Can be called by either
    /// the buyer or the seller. Blocks normal release and refund.
    pub fn dispute(env: Env, caller: Address, id: BytesN<32>) {
        caller.require_auth();

        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error(&env, Error::TradeNotFound));

        if state.status != TradeStatus::Locked {
            panic_with_error(&env, Error::TradeNotLocked);
        }

        if env.ledger().sequence() >= state.timeout_ledger {
            panic_with_error(&env, Error::TimeoutReached);
        }

        if caller != state.buyer && caller != state.seller {
            panic_with_error(&env, Error::Unauthorized);
        }

        state.status = TradeStatus::Disputed;
        env.storage().persistent().set(&key, &state);

        env.events()
            .publish((symbol_short(&env, "disputed"), id), (caller,));
    }

    /// Resolve a disputed trade. Can only be called by the admin.
    /// If resolve_to_buyer is true, funds are returned to the buyer in full.
    /// If resolve_to_buyer is false, funds are released to the seller minus the platform fee.
    pub fn resolve(env: Env, id: BytesN<32>, resolve_to_buyer: bool, signers: Vec<Address>) {
        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error(&env, Error::TradeNotFound));

        if state.status != TradeStatus::Disputed {
            panic_with_error(&env, Error::TradeNotDisputed);
        }

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error(&env, Error::NotInitialized));
        // Resolving a disputed trade moves escrowed funds, so it is a privileged
        // action: gate it by the multisig (or the single admin in legacy mode),
        // never by a lone admin key once multisig is active.
        require_multisig(&env, &signers).unwrap_or_else(|e| panic_with_error(&env, e));

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);

        if resolve_to_buyer {
            client.transfer(&env.current_contract_address(), &state.buyer, &state.amount);
            state.status = TradeStatus::Refunded;
        } else {
            let fee_bps: u32 = env
                .storage()
                .instance()
                .get(&DataKey::PlatformFeeBps)
                .unwrap_or(0);
            let fee = (state.amount * fee_bps as i128) / 10_000;
            let payout = state.amount - fee;

            client.transfer(&env.current_contract_address(), &state.seller, &payout);
            if fee > 0 {
                client.transfer(&env.current_contract_address(), &admin, &fee);
            }
            state.status = TradeStatus::Released;
        }

        env.storage().persistent().set(&key, &state);

        env.events().publish(
            (symbol_short(&env, "resolved"), id),
            (resolve_to_buyer, state.amount),
        );
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

        env.storage().instance().set(&DataKey::Signers, &signers);
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
        env.storage().instance().set(&DataKey::Signers, &signers);
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
    pub fn set_platform_fee(env: Env, fee_bps: u32, signers: Vec<Address>) -> Result<(), Error> {
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

    /// Release many trades in a single invocation — the on-chain half of
    /// provider payout batching (see docs/provider-payout-batching.md).
    ///
    /// This is permissionless, exactly like `release()`: each item is
    /// verified independently against its own trade's `secret_hash`, so
    /// batching never lets one trade's payout ride on another's
    /// authorization. An item that doesn't correspond to a `Locked` trade,
    /// or whose secret doesn't match, is silently skipped rather than
    /// reverting the whole batch — one stale or malformed entry must not
    /// be able to block payout for every other provider in the batch.
    /// Returns the ids that were actually released, so the caller can
    /// retry whatever didn't make it.
    pub fn batch_release(
        env: Env,
        releases: Vec<BatchReleaseItem>,
    ) -> Result<Vec<BytesN<32>>, Error> {
        if releases.len() > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(0);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        let client = token::Client::new(&env, &token_addr);

        let mut released: Vec<BytesN<32>> = Vec::new(&env);
        for item in releases.iter() {
            let key = DataKey::Trade(item.id.clone());
            let mut state: TradeState = match env.storage().persistent().get(&key) {
                Some(s) => s,
                None => continue,
            };
            if state.status != TradeStatus::Locked {
                continue;
            }

            let computed = env.crypto().sha256(&item.secret.clone().into());
            if computed.to_bytes() != state.secret_hash {
                continue;
            }

            let fee = (state.amount * fee_bps as i128) / 10_000;
            let payout = state.amount - fee;

            // CEI pattern, same as release(): update state before external calls.
            state.status = TradeStatus::Released;
            env.storage().persistent().set(&key, &state);

            client.transfer(&env.current_contract_address(), &state.seller, &payout);
            if fee > 0 {
                client.transfer(&env.current_contract_address(), &admin, &fee);
            }

            env.events()
                .publish((symbol_short(&env, "released"), item.id.clone()), payout);
            released.push_back(item.id.clone());
        }

        Ok(released)
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
    if let Some(paused) = env
        .storage()
        .instance()
        .get::<DataKey, bool>(&DataKey::Paused)
    {
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
        let authorized: Vec<Address> = env.storage().instance().get(&DataKey::Signers).unwrap();
        validate_signers(env, provided_signers, &authorized, threshold)?;
    } else {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
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
    // Count DISTINCT authorized signers. Without the duplicate check a single
    // compromised key could satisfy any threshold by passing itself N times
    // (e.g. [k, k, k] for a 3-of-M policy), since require_auth() on the same
    // address succeeds with one signature. Deduplicating is what actually
    // enforces "no single party can act alone".
    for i in 0..provided.len() {
        let signer = provided.get(i).unwrap();
        if !is_authorized(&signer, authorized) {
            return Err(Error::NotAuthorized);
        }
        // Reject any repeat of an earlier entry.
        for j in 0..i {
            if provided.get(j).unwrap() == signer {
                return Err(Error::DuplicateSigner);
            }
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
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token, vec, Address, BytesN, Env,
    };

    struct Fixture {
        env: Env,
        client: EscrowContractClient<'static>,
        token: token::Client<'static>,
        contract_id: Address,
        admin: Address,
        seller: Address,
        buyer: Address,
        secret: BytesN<32>,
        secret_hash: BytesN<32>,
        id: BytesN<32>,
    }

    fn setup(mint_to_buyer: i128, fee_bps: u32) -> Fixture {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let token = token::Client::new(&env, &token_addr);
        let token_admin = token::StellarAssetClient::new(&env, &token_addr);
        token_admin.mint(&buyer, &mint_to_buyer);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_addr, &fee_bps);

        let secret = BytesN::from_array(&env, &[7u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
        let id = BytesN::from_array(&env, &[1u8; 32]);

        Fixture {
            env,
            client,
            token,
            contract_id,
            admin,
            seller,
            buyer,
            secret,
            secret_hash,
            id,
        }
    }

    #[test]
    fn test_lock_and_release() {
        let f = setup(1_000, 100); // 100 bps = 1%
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        assert_eq!(f.token.balance(&f.buyer), 500);
        assert_eq!(f.token.balance(&f.contract_id), 500);

        f.client.release(&f.id, &f.secret);

        // 1% fee -> 5 stroops.
        assert_eq!(f.token.balance(&f.seller), 495);
        assert_eq!(f.token.balance(&f.admin), 5);
        assert_eq!(f.token.balance(&f.contract_id), 0);

        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Released);
    }

    #[test]
    fn test_lock_and_refund() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.env.ledger().with_mut(|li| li.sequence_number += 101);
        f.client.refund(&f.id);

        assert_eq!(f.token.balance(&f.buyer), 1_000);
        assert_eq!(f.token.balance(&f.contract_id), 0);

        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Refunded);
    }

    #[test]
    fn test_dispute_by_buyer_and_resolve_to_buyer() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.client.dispute(&f.buyer, &f.id);

        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Disputed);

        // Resolve to buyer (full refund). Single-admin mode: the signers vec is
        // unused because require_multisig falls back to admin.require_auth().
        f.client.resolve(&f.id, &true, &Vec::new(&f.env));

        assert_eq!(f.token.balance(&f.buyer), 1_000);
        assert_eq!(f.token.balance(&f.contract_id), 0);

        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Refunded);
    }

    #[test]
    fn test_dispute_by_seller_and_resolve_to_seller() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.client.dispute(&f.seller, &f.id);

        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Disputed);

        // Resolve to seller (payout minus fee). Single-admin mode as above.
        f.client.resolve(&f.id, &false, &Vec::new(&f.env));

        assert_eq!(f.token.balance(&f.seller), 495);
        assert_eq!(f.token.balance(&f.admin), 5);
        assert_eq!(f.token.balance(&f.contract_id), 0);

        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Released);
    }

    #[test]
    #[should_panic]
    fn test_dispute_after_timeout_fails() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.env.ledger().with_mut(|li| li.sequence_number += 101);
        f.client.dispute(&f.buyer, &f.id);
    }

    #[test]
    #[should_panic]
    fn test_dispute_unauthorized_fails() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        let random_addr = Address::generate(&f.env);
        f.client.dispute(&random_addr, &f.id);
    }

    #[test]
    #[should_panic]
    fn test_dispute_blocks_refund() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.client.dispute(&f.buyer, &f.id);

        f.env.ledger().with_mut(|li| li.sequence_number += 101);
        f.client.refund(&f.id);
    }

    #[test]
    #[should_panic]
    fn test_dispute_blocks_release() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.client.dispute(&f.buyer, &f.id);

        f.client.release(&f.id, &f.secret);
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

    // ------------------------------------------------------------------
    // Threshold custody for admin authority (issue #215).
    //
    // These tests demonstrate the property the issue asks for: once N-of-M
    // custody is active, no single key can exercise admin authority alone.
    // Auth is mocked (`mock_all_auths`), which is precisely the adversary
    // model for a *compromised* key: its signature always verifies, so the
    // contract's own quorum logic is the only thing standing in the way.
    // ------------------------------------------------------------------

    struct Multisig {
        f: Fixture,
        s1: Address,
        s2: Address,
        s3: Address,
    }

    /// 2-of-3 custody over a freshly initialized contract.
    fn setup_multisig() -> Multisig {
        let f = setup(1_000, 100);
        let s1 = Address::generate(&f.env);
        let s2 = Address::generate(&f.env);
        let s3 = Address::generate(&f.env);
        f.client
            .migrate_to_multisig(&vec![&f.env, s1.clone(), s2.clone(), s3.clone()], &2);
        Multisig { f, s1, s2, s3 }
    }

    #[test]
    fn multisig_rejects_a_single_key_repeated_to_meet_threshold() {
        // The critical case: one compromised holder passing itself twice must
        // NOT satisfy a 2-of-3 policy, even though require_auth() succeeds for
        // it both times.
        let m = setup_multisig();
        let duplicated = vec![&m.f.env, m.s1.clone(), m.s1.clone()];
        assert!(m.f.client.try_set_platform_fee(&250, &duplicated).is_err());
    }

    #[test]
    fn multisig_rejects_below_threshold() {
        let m = setup_multisig();
        let single = vec![&m.f.env, m.s1.clone()];
        assert!(m.f.client.try_set_platform_fee(&250, &single).is_err());
    }

    #[test]
    fn multisig_rejects_an_unauthorized_signer() {
        let m = setup_multisig();
        let outsider = Address::generate(&m.f.env);
        let mixed = vec![&m.f.env, m.s1.clone(), outsider];
        assert!(m.f.client.try_set_platform_fee(&250, &mixed).is_err());
    }

    #[test]
    fn multisig_accepts_distinct_threshold_signers() {
        let m = setup_multisig();
        let quorum = vec![&m.f.env, m.s1.clone(), m.s2.clone()];
        assert!(m.f.client.try_set_platform_fee(&250, &quorum).is_ok());
    }

    #[test]
    fn resolve_requires_a_quorum_once_multisig_is_active() {
        // Dispute resolution moves escrowed funds, so it must not remain a
        // single-key action after migration.
        let m = setup_multisig();
        m.f.client.lock(
            &m.f.id,
            &m.f.seller,
            &m.f.buyer,
            &500,
            &m.f.secret_hash,
            &100,
        );
        m.f.client.dispute(&m.f.buyer, &m.f.id);

        let single = vec![&m.f.env, m.s1.clone()];
        assert!(m.f.client.try_resolve(&m.f.id, &true, &single).is_err());

        let quorum = vec![&m.f.env, m.s1.clone(), m.s2.clone()];
        assert!(m.f.client.try_resolve(&m.f.id, &true, &quorum).is_ok());
        assert_eq!(m.f.token.balance(&m.f.buyer), 1_000);
    }

    #[test]
    fn signer_rotation_requires_a_quorum_and_enables_recovery() {
        // Recovery ceremony: a quorum of the remaining holders rotates out a
        // lost or compromised key.
        let m = setup_multisig();
        let replacement = Address::generate(&m.f.env);
        let new_set = vec![&m.f.env, m.s2.clone(), m.s3.clone(), replacement];

        // A lone holder cannot rotate the signer set.
        let single = vec![&m.f.env, m.s2.clone()];
        assert!(m.f.client.try_set_signers(&new_set, &2, &single).is_err());

        // A quorum can.
        let quorum = vec![&m.f.env, m.s2.clone(), m.s3.clone()];
        assert!(m.f.client.try_set_signers(&new_set, &2, &quorum).is_ok());

        // The rotated-out key no longer counts toward a quorum.
        let stale = vec![&m.f.env, m.s1.clone(), m.s2.clone()];
        assert!(m.f.client.try_set_platform_fee(&300, &stale).is_err());
    }

    // ------------------------------------------------------------------
    // Provider payout batching: batch_release().
    //
    // An off-chain coordinator accumulates trades whose secrets are
    // already known (revealed at hand-off) and submits them together in
    // one Soroban invocation to amortize the base fee across trades.
    // These tests check the property that actually matters: batching must
    // not weaken release()'s per-trade guarantee — each item is verified
    // against its own trade's secret_hash independently, so one bad or
    // stale entry can never ride on, or block, another trade's payout.
    // ------------------------------------------------------------------

    #[test]
    fn batch_release_pays_multiple_sellers_in_one_call() {
        let f = setup(2_000, 100); // 1% fee
        let seller2 = Address::generate(&f.env);
        let secret2 = BytesN::from_array(&f.env, &[8u8; 32]);
        let secret_hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
        let id2 = BytesN::from_array(&f.env, &[2u8; 32]);

        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
        f.client
            .lock(&id2, &seller2, &f.buyer, &300, &secret_hash2, &100);

        let releases = vec![
            &f.env,
            BatchReleaseItem {
                id: f.id.clone(),
                secret: f.secret.clone(),
            },
            BatchReleaseItem {
                id: id2.clone(),
                secret: secret2,
            },
        ];
        let released = f.client.batch_release(&releases);

        assert_eq!(released.len(), 2);
        assert_eq!(f.token.balance(&f.seller), 495); // 500 - 1%
        assert_eq!(f.token.balance(&seller2), 297); // 300 - 1%
        assert_eq!(f.token.balance(&f.admin), 8); // 5 + 3

        assert_eq!(
            f.client.get_trade(&f.id).unwrap().status,
            TradeStatus::Released
        );
        assert_eq!(
            f.client.get_trade(&id2).unwrap().status,
            TradeStatus::Released
        );
    }

    #[test]
    fn batch_release_skips_invalid_entries_without_reverting_the_batch() {
        let f = setup(2_000, 100);
        let seller2 = Address::generate(&f.env);
        let secret2 = BytesN::from_array(&f.env, &[8u8; 32]);
        let secret_hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
        let id2 = BytesN::from_array(&f.env, &[2u8; 32]);
        let wrong_secret = BytesN::from_array(&f.env, &[9u8; 32]);

        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
        f.client
            .lock(&id2, &seller2, &f.buyer, &300, &secret_hash2, &100);

        let releases = vec![
            &f.env,
            BatchReleaseItem {
                id: f.id.clone(),
                secret: f.secret.clone(),
            },
            BatchReleaseItem {
                id: id2.clone(),
                secret: wrong_secret,
            },
        ];
        let released = f.client.batch_release(&releases);

        // Only the entry with the correct secret gets released.
        assert_eq!(released.len(), 1);
        assert_eq!(released.get(0).unwrap(), f.id.clone());
        assert_eq!(f.token.balance(&f.seller), 495);
        assert_eq!(f.token.balance(&seller2), 0);
        assert_eq!(
            f.client.get_trade(&f.id).unwrap().status,
            TradeStatus::Released
        );
        // The bad entry's trade is untouched — still Locked, funds still escrowed.
        assert_eq!(
            f.client.get_trade(&id2).unwrap().status,
            TradeStatus::Locked
        );
    }

    #[test]
    fn batch_release_skips_unknown_and_already_released_ids() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
        f.client.release(&f.id, &f.secret);

        let unknown_id = BytesN::from_array(&f.env, &[99u8; 32]);
        let releases = vec![
            &f.env,
            BatchReleaseItem {
                id: f.id.clone(),
                secret: f.secret.clone(),
            }, // already released
            BatchReleaseItem {
                id: unknown_id,
                secret: f.secret.clone(),
            }, // never locked
        ];
        let released = f.client.batch_release(&releases);
        assert_eq!(released.len(), 0);
    }

    #[test]
    fn batch_release_rejects_a_batch_larger_than_the_cap() {
        let f = setup(1_000, 100);
        let mut releases: Vec<BatchReleaseItem> = Vec::new(&f.env);
        for i in 0..(MAX_BATCH_SIZE + 1) {
            let id = BytesN::from_array(&f.env, &[i as u8; 32]);
            releases.push_back(BatchReleaseItem {
                id,
                secret: f.secret.clone(),
            });
        }
        assert!(f.client.try_batch_release(&releases).is_err());
    }
}

#[cfg(test)]
mod property_test;
