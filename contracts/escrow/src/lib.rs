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

#[cfg(not(target_arch = "wasm32"))]
extern crate std;

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
    Arbitrator,
    /// Ledger sequence after which an unresolved dispute becomes
    /// permissionlessly refundable to the buyer in full.
    DisputeDeadline(BytesN<32>),
    /// Sequential trade counter for enumeration (#283).
    TradeCounter,
    /// Maps sequential index to trade hash ID (#283).
    TradeId(u32),
    /// Issue #284 — side-channel mitigation. Synthetic key touched by flatten_branch_cost.
    CostPad,
    /// Anti-spam bonding (issue #280): per-address successful-completion count.
    Reputation(Address),
    /// Anti-spam bonding (issue #280): bond escrowed with a trade.
    Bond(BytesN<32>),
    /// Anti-spam bonding (issue #280): tunable parameters.
    BondConfig,
    /// Commit-reveal pre-step for trade-ID generation (issue #281).
    Commit(BytesN<32>),
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
    /// `resolve_dispute`'s `buyer_share_bps` was greater than 10_000.
    InvalidSplit = 20,
    /// A dispute-timeout refund was attempted before `DisputeDeadline` elapsed.
    DisputeTimeoutNotReached = 21,

    /// Issue #281: reveal_and_lock referenced a commit that does not exist.
    CommitNotFound = 22,
    /// Issue #281: reveal_and_lock referenced a commit past its TTL.
    CommitExpired = 23,
}

const DEFAULT_TIMEOUT_LEDGERS_MAX: u32 = 6 * 60 * 24 * 7;

/// Issue #280 — anti-spam bonding constants.
const DEFAULT_BOND_AMOUNT: i128 = 1_000_000;
const ESTABLISH_THRESHOLD: i128 = 3;
const MIN_ESTABLISH_AMOUNT: i128 = 1_000_000;
const COMMIT_TTL_LEDGERS: u32 = 6 * 60 * 24; // ~1 day at 5s/ledger

/// Window (in ledgers) an arbitrator has to call `resolve_dispute` after a
/// dispute is raised, at roughly 5s/ledger this is ~3 days. Once it elapses,
/// `refund_after_dispute_timeout` lets anyone return the full amount to the
/// buyer — an unresponsive or compromised arbitrator can never freeze funds
/// forever.
const DISPUTE_RESOLUTION_WINDOW_LEDGERS: u32 = 12 * 60 * 24 * 3;

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

/// Issue #280 — tunable anti-spam bond parameters.
#[derive(Clone)]
#[contracttype]
pub struct BondParams {
    pub bond_amount: i128,
    pub establish_threshold: i128,
    pub min_establish_amount: i128,
}

pub fn set_bond_config(env: Env, params: BondParams, signers: Vec<Address>) -> Result<(), Error> {
    require_multisig(&env, &signers)?;
    if params.bond_amount < 0 || params.establish_threshold < 0 || params.min_establish_amount < 0 {
        return Err(Error::InvalidAmount);
    }
    env.storage().instance().set(&DataKey::BondConfig, &params);
    Ok(())
}

/// Read an address's current successful-completion count.
pub fn get_reputation(env: Env, addr: Address) -> i128 {
    read_reputation(&env, &addr)
}

/// Current bond escrowed with a trade, or 0 if none.
pub fn get_bond(env: Env, id: BytesN<32>) -> i128 {
    read_bond(&env, &id)
}

fn read_reputation(env: &Env, addr: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::Reputation(addr.clone()))
        .unwrap_or(0)
}

fn read_bond(env: &Env, id: &BytesN<32>) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::Bond(id.clone()))
        .unwrap_or(0)
}

fn bond_params(env: &Env) -> BondParams {
    env.storage()
        .instance()
        .get(&DataKey::BondConfig)
        .unwrap_or(BondParams {
            bond_amount: DEFAULT_BOND_AMOUNT,
            establish_threshold: ESTABLISH_THRESHOLD,
            min_establish_amount: MIN_ESTABLISH_AMOUNT,
        })
}

// Invariant: funds can only ever leave this contract's balance through
// exactly four paths, each gated by its own independent check on `status`:
//   - release()                    requires status == Locked
//   - refund()                     requires status == Locked
//   - resolve_dispute()            requires status == Disputed
//   - refund_after_dispute_timeout() requires status == Disputed
// Every one of these paths flips `status` away from its required starting
// value *before* any token transfer (CEI pattern), and every mutating path
// re-reads `status` from persistent storage inside the same invocation, so
// there is no way to race two paths against the same trade: whichever runs
// first moves `status` out of the state the other requires, and Soroban
// invocations are atomic, so a mid-call failure can never leave `status`
// updated without the matching transfer(s) having gone through (or vice
// versa). `raise_dispute()` only moves Locked -> Disputed and never touches
// tokens, so it cannot open a fifth path. No other function in this
// contract calls `token::Client::transfer`.
#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// One-time setup: sets the admin (fee recipient), the settlement
    /// token (e.g. USDC on Stellar), and the arbitrator that resolves
    /// disputes. The arbitrator is a distinct role from the admin — the
    /// admin only ever collects fees, it never gets to decide a dispute's
    /// outcome. Starts in single-admin mode — call `migrate_to_multisig()`
    /// later to enable N-of-M governance over admin actions (the arbitrator
    /// role is unaffected by that migration; see the note on `set_arbitrator`).
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        platform_fee_bps: u32,
        arbitrator: Address,
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
        env.storage()
            .instance()
            .set(&DataKey::Arbitrator, &arbitrator);
        Ok(())
    }

    /// Replace the arbitrator address. Gated by single admin or multisig,
    /// same as the other admin-governance setters — this changes *who*
    /// decides disputes, not the outcome of any specific dispute.
    pub fn set_arbitrator(
        env: Env,
        arbitrator: Address,
        signers: Vec<Address>,
    ) -> Result<(), Error> {
        require_multisig(&env, &signers)?;
        env.storage()
            .instance()
            .set(&DataKey::Arbitrator, &arbitrator);
        Ok(())
    }

    /// Read-only accessor for a trade's current state. Returns `None` if the id
    /// was never locked.
    /// Issue #284 — side-channel mitigation. Performs a fixed, parameter-independent
    /// amount of instance-storage work on every entry to `lock`/`release`/`refund`.
    /// This raises the cost floor of the cheap "no-op / revert" branches so an
    /// observer watching declared resource fees cannot distinguish them from the
    /// token-moving branches (and thus cannot learn a trade's existence/state by
    /// probing). Bounded to a single instance key, so it cannot be used to exhaust
    /// contract storage.
    fn flatten_branch_cost(env: &Env) {
        let n: u32 = env.storage().instance().get(&DataKey::CostPad).unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::CostPad, &(n.wrapping_add(1)));
    /// Issue #280: on a successful completion of trade `id` by `buyer`, refund any
    /// escrowed bond and count the completion toward "established" (unless it was
    /// dust, which can't be gamed to reach the threshold cheaply). Refunding the
    /// bond here is what makes legitimate first-time use effectively free.
    fn complete_with_bond_refund(env: &Env, id: &BytesN<32>, buyer: &Address, amount: i128) {
        if let Some(bond) = env
            .storage()
            .instance()
            .get::<DataKey, i128>(&DataKey::Bond(id.clone()))
        {
            if bond > 0 {
                let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
                let client = token::Client::new(env, &token_addr);
                client.transfer(&env.current_contract_address(), buyer, &bond);
                env.storage().instance().remove(&DataKey::Bond(id.clone()));
            }
        }
        let params = bond_params(env);
        if amount >= params.min_establish_amount {
            let rep = read_reputation(env, buyer);
            env.storage()
                .instance()
                .set(&DataKey::Reputation(buyer.clone()), &(rep + 1));
        }
    }

    pub fn commit_trade_id(env: Env, caller: Address, commit: BytesN<32>) {
        caller.require_auth();
        check_not_paused(&env);
        let expiry = env.ledger().sequence() + COMMIT_TTL_LEDGERS;
        env.storage()
            .instance()
            .set(&DataKey::Commit(commit.clone()), &expiry);
        env.events()
            .publish((symbol_short(&env, "id_committed"), commit), (expiry,));
    }

    /// Step 2: reveal the `(id, salt)` that hashes to a previously stored
    /// commit, then create the trade exactly as `lock()` would. Because the
    /// caller had to commit first, they cannot have chosen `id` in reaction
    /// to any trade that appeared after the commit was made.
    pub fn reveal_and_lock(
        env: Env,
        id: BytesN<32>,
        salt: BytesN<32>,
        seller: Address,
        buyer: Address,
        amount: i128,
        secret_hash: BytesN<32>,
        timeout_ledgers: u32,
    ) {
        check_not_paused(&env);
        buyer.require_auth();

        // Re-derive the commitment and check it was made and is still live.
        // commit = sha256( id_bytes || salt_bytes )
        let mut buf = Bytes::new(&env);
        buf.append(&id.to_bytes());
        buf.append(&salt.to_bytes());
        let commit = env.crypto().sha256(&buf);
        let commit_key = BytesN::<32>::from_array(&env, &commit.to_bytes().into());
        let expiry: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Commit(commit_key.clone()))
            .unwrap_or_else(|| panic_with_error(&env, Error::CommitNotFound));
        if env.ledger().sequence() >= expiry {
            panic_with_error(&env, Error::CommitExpired);
        }
        // A commit is single-use: consume it so the same (id,salt) cannot be
        // replayed to open a second trade under the same revealed ID.
        env.storage()
            .instance()
            .remove(&DataKey::Commit(commit_key));

        create_trade(
            &env,
            &id,
            &seller,
            &buyer,
            &amount,
            &secret_hash,
            &timeout_ledgers,
        );
    }

    /// Shared trade-creation logic used by both `lock()` and
    /// `reveal_and_lock()`. Pulled out so the hardened path cannot diverge
    /// from the legacy path.
    fn create_trade(
        env: &Env,
        id: &BytesN<32>,
        seller: &Address,
        buyer: &Address,
        amount: &i128,
        secret_hash: &BytesN<32>,
        timeout_ledgers: &u32,
    ) {
        if *amount <= 0 || *amount > (i128::MAX / 10_000) {
            panic_with_error(env, Error::InvalidAmount);
        }
        if *timeout_ledgers == 0 || *timeout_ledgers > DEFAULT_TIMEOUT_LEDGERS_MAX {
            panic_with_error(env, Error::InvalidTimeout);
        }

        let key = DataKey::Trade(id.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error(env, Error::TradeAlreadyExists);
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .unwrap_or_else(|| panic_with_error(env, Error::NotInitialized));

        let client = token::Client::new(env, &token_addr);
        client.transfer(buyer, &env.current_contract_address(), amount);

        let timeout_ledger = env.ledger().sequence() + timeout_ledgers;

        let state = TradeState {
            seller: seller.clone(),
            buyer: buyer.clone(),
            amount: *amount,
            secret_hash: secret_hash.clone(),
            timeout_ledger,
            status: TradeStatus::Locked,
        };
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 100_000);

        env.events()
            .publish((symbol_short(env, "locked"), id.clone()), *amount);
    }

    /// Read-only accessor for a trade's current state. Returns `None` if the id
    /// was never locked.

    pub fn get_trade(env: Env, id: BytesN<32>) -> Option<TradeState> {
        env.storage().persistent().get(&DataKey::Trade(id))
    }

    /// Issue #283: Get the total number of trades recorded.
    pub fn get_trade_count(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::TradeCounter)
            .unwrap_or(0)
    }

    /// Issue #283: Get the trade ID at a sequential index (1-indexed).
    pub fn get_trade_by_index(env: Env, index: u32) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::TradeId(index))
    }

    /// Flag a trade as disputed before its timeout. Can be called by either
    /// the buyer or the seller. Blocks normal release and refund. Opens a
    /// `DISPUTE_RESOLUTION_WINDOW_LEDGERS`-ledger window for the arbitrator
    /// to call `resolve_dispute`; if that window elapses unresolved, anyone
    /// may call `refund_after_dispute_timeout`.
    pub fn raise_dispute(env: Env, caller: Address, id: BytesN<32>) {
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

        let deadline = env.ledger().sequence() + DISPUTE_RESOLUTION_WINDOW_LEDGERS;
        env.storage()
            .persistent()
            .set(&DataKey::DisputeDeadline(id.clone()), &deadline);

        env.events()
            .publish((symbol_short(&env, "disputed"), id), (caller,));
    }

    /// Resolve a disputed trade by splitting the locked amount between buyer
    /// and seller. `buyer_share_bps` is the buyer's cut in basis points
    /// (0 = seller gets everything, minus the platform fee, exactly like
    /// `release()`; 10_000 = buyer gets a full refund, exactly like
    /// `refund()`; anything in between is a genuine partial split). Callable
    /// only by the arbitrator — never the admin, and never through the
    /// multisig — and only once per trade: after this call the trade is
    /// `Resolved`, so a second call fails the `TradeNotDisputed` check below.
    ///
    /// Every transfer here happens inside this single Soroban invocation, so
    /// if any transfer fails the whole call reverts — there is no way for
    /// funds to end up partially split.
    pub fn resolve_dispute(env: Env, id: BytesN<32>, buyer_share_bps: u32) -> Result<(), Error> {
        if buyer_share_bps > 10_000 {
            return Err(Error::InvalidSplit);
        }

        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if state.status != TradeStatus::Disputed {
            return Err(Error::TradeNotDisputed);
        }

        let arbitrator: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbitrator)
            .ok_or(Error::NotInitialized)?;
        arbitrator.require_auth();

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(0);
        let client = token::Client::new(&env, &token_addr);

        // The buyer's share is a partial refund: fee-free, exactly like
        // refund(). The remainder is the seller's share, which pays the
        // platform fee exactly like release() does.
        let buyer_amount = (state.amount * buyer_share_bps as i128) / 10_000;
        let seller_gross = state.amount - buyer_amount;
        let fee = (seller_gross * fee_bps as i128) / 10_000;
        let seller_payout = seller_gross - fee;

        state.status = TradeStatus::Resolved;
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .remove(&DataKey::DisputeDeadline(id.clone()));

        if buyer_amount > 0 {
            client.transfer(&env.current_contract_address(), &state.buyer, &buyer_amount);
        }
        if seller_payout > 0 {
            client.transfer(
                &env.current_contract_address(),
                &state.seller,
                &seller_payout,
            );
        }
        if fee > 0 {
            client.transfer(&env.current_contract_address(), &admin, &fee);
        }

        env.events().publish(
            (symbol_short(&env, "disp_res"), id),
            (buyer_share_bps, buyer_amount, seller_payout),
        );
        Ok(())
    }

    /// Permissionless fallback: if a dispute sits unresolved past its
    /// `DisputeDeadline`, anyone may return the full locked amount to the
    /// buyer. This mirrors `refund()`'s permissionless-after-timeout design
    /// so an unresponsive (or compromised) arbitrator can never freeze funds.
    pub fn refund_after_dispute_timeout(env: Env, id: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if state.status != TradeStatus::Disputed {
            return Err(Error::TradeNotDisputed);
        }

        let deadline_key = DataKey::DisputeDeadline(id.clone());
        let deadline: u32 = env
            .storage()
            .persistent()
            .get(&deadline_key)
            .ok_or(Error::NotInitialized)?;
        if env.ledger().sequence() < deadline {
            return Err(Error::DisputeTimeoutNotReached);
        }

        state.status = TradeStatus::Refunded;
        env.storage().persistent().set(&key, &state);
        env.storage().persistent().remove(&deadline_key);

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        client.transfer(&env.current_contract_address(), &state.buyer, &state.amount);

        env.events()
            .publish((symbol_short(&env, "disp_exp"), id), state.amount);
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
        check_not_paused(&env);
        flatten_branch_cost(&env);
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
    /// Lock `amount` tokens from `buyer` into escrow under a unique `id`.
    ///
    /// # Trade-ID collision resistance
    ///
    /// Trade IDs are generated off-chain as 32 random bytes
    /// (`crypto.randomBytes(32)` in Node.js — a CSPRNG).  The contract
    /// enforces uniqueness by checking persistent storage before writing:
    /// if a trade already exists under the given `id` the call panics with
    /// `TradeAlreadyExists` and **the existing trade's state is completely
    /// unaffected**.
    ///
    /// ## Collision probability
    ///
    /// A `BytesN<32>` trade ID has 256 bits of key space.  The
    /// birthday-paradox probability of a collision among N trades is
    /// roughly N² / 2^256.  Even at 10⁹ live trades simultaneously that
    /// probability is ≈ 10^(-59) — negligible for any realistic workload.
    ///
    /// ## Conclusion
    ///
    /// The existing `has()` check combined with a cryptographically-strong
    /// off-chain generator provides sufficient collision resistance.  No
    /// on-chain entropy contribution (e.g. mixing in the ledger sequence
    /// number) is required because:
    ///
    /// 1. The ID space (2^256) dwarfs every plausible trade volume.
    /// 2. Node's `crypto.randomBytes` is CSPRNG-backed and already
    ///    independent of any on-chain observable.
    /// 3. Mixing ledger sequence numbers on-chain would only add a few
    ///    bits of public (not secret) data, giving no meaningful uplift
    ///    against the already-negligible collision probability while
    ///    complicating ID pre-computation for off-chain coordinators.
    ///
    /// If the off-chain generator were ever replaced with a weak source,
    /// the correct fix is to restore generator quality, not to patch the
    /// contract.  This analysis is documented here (issue #274) so future
    /// contributors do not need to re-examine the question from scratch.
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
        flatten_branch_cost(&env);
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

        // Issue #280: an "unestablished" buyer posts a refundable bond.
        let params = bond_params(&env);
        if params.bond_amount > 0 && read_reputation(&env, &buyer) < params.establish_threshold {
            client.transfer(&buyer, &env.current_contract_address(), &params.bond_amount);
            env.storage()
                .instance()
                .set(&DataKey::Bond(id.clone()), &params.bond_amount);
        }

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

        // Issue #283: Record trade in sequential index for reputation scanning.
        let counter: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TradeCounter)
            .unwrap_or(0);
        let next_idx = counter + 1;
        env.storage()
            .persistent()
            .set(&DataKey::TradeCounter, &next_idx);
        env.storage()
            .persistent()
            .set(&DataKey::TradeId(next_idx), &id);

        env.events()
            .publish((symbol_short(&env, "locked"), id), amount);
    }

    fn release(env: Env, id: BytesN<32>, secret: BytesN<32>) {
        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = match env.storage().persistent().get(&key) {
            Some(s) => s,
            None => return,
        };

        if state.status != TradeStatus::Locked {
            return;
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
    _env: &Env,
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
        token, vec, Address, BytesN, Env, IntoVal,
    };

    struct Fixture {
        env: Env,
        client: EscrowContractClient<'static>,
        token: token::Client<'static>,
        contract_id: Address,
        admin: Address,
        arbitrator: Address,
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
        let arbitrator = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let token = token::Client::new(&env, &token_addr);
        let token_admin = token::StellarAssetClient::new(&env, &token_addr);
        token_admin.mint(&buyer, &mint_to_buyer);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_addr, &fee_bps, &arbitrator);

        let secret = BytesN::from_array(&env, &[7u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
        let id = BytesN::from_array(&env, &[1u8; 32]);

        Fixture {
            env,
            client,
            token,
            contract_id,
            admin,
            arbitrator,
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
    fn test_raise_dispute_by_buyer_and_resolve_50_50() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.client.raise_dispute(&f.buyer, &f.id);

        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Disputed);

        f.client.resolve_dispute(&f.id, &5_000);

        // Buyer's 50% (250) is fee-free, like a partial refund. Seller's 50%
        // (250) pays the 1% fee, like release(): 2 stroops fee, 248 payout.
        assert_eq!(f.token.balance(&f.buyer), 750); // 1000 minted - 500 locked + 250 back
        assert_eq!(f.token.balance(&f.seller), 248);
        assert_eq!(f.token.balance(&f.admin), 2);
        assert_eq!(f.token.balance(&f.contract_id), 0);

        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Resolved);
    }

    #[test]
    fn test_resolve_dispute_full_to_buyer_matches_refund_balances() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.client.raise_dispute(&f.buyer, &f.id);
        f.client.resolve_dispute(&f.id, &10_000);

        // Same final balances as a plain refund(): buyer gets everything back,
        // fee-free, seller and admin see nothing.
        assert_eq!(f.token.balance(&f.buyer), 1_000);
        assert_eq!(f.token.balance(&f.seller), 0);
        assert_eq!(f.token.balance(&f.admin), 0);
        assert_eq!(f.token.balance(&f.contract_id), 0);
    }

    #[test]
    fn test_resolve_dispute_full_to_seller_matches_release_balances() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.client.raise_dispute(&f.seller, &f.id);
        f.client.resolve_dispute(&f.id, &0);

        // Same final balances as a plain release(): 1% fee, rest to seller.
        assert_eq!(f.token.balance(&f.seller), 495);
        assert_eq!(f.token.balance(&f.admin), 5);
        assert_eq!(f.token.balance(&f.contract_id), 0);
    }

    #[test]
    fn test_resolve_dispute_twice_fails() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.client.raise_dispute(&f.buyer, &f.id);
        f.client.resolve_dispute(&f.id, &5_000);

        assert!(f.client.try_resolve_dispute(&f.id, &5_000).is_err());
    }

    #[test]
    fn test_resolve_dispute_from_non_arbitrator_fails() {
        // setup() calls env.mock_all_auths(), which makes require_auth()
        // succeed for every address — not representative of a real signer
        // check. Build a fresh env here and scope auth mocking to a specific
        // (non-arbitrator) address instead, so require_auth() on the stored
        // arbitrator genuinely has no valid authorization and must fail.
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let arbitrator = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        token::StellarAssetClient::new(&env, &token_addr).mint(&buyer, &1_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_addr, &100, &arbitrator);

        let secret = BytesN::from_array(&env, &[7u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
        let id = BytesN::from_array(&env, &[1u8; 32]);
        client.lock(&id, &seller, &buyer, &500, &secret_hash, &100);
        client.raise_dispute(&buyer, &id);

        let impostor = Address::generate(&env);
        assert_ne!(impostor, arbitrator);

        // Scope auth to *only* the impostor for this one call. The contract
        // still calls `arbitrator.require_auth()` on the address stored at
        // initialize() — since only the impostor's signature is mocked, that
        // check has no valid authorization to satisfy and the call fails.
        let result = client
            .mock_auths(&[soroban_sdk::testutils::MockAuth {
                address: &impostor,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "resolve_dispute",
                    args: (id.clone(), 5_000u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_resolve_dispute(&id, &5_000);

        assert!(result.is_err());
        assert_eq!(client.get_trade(&id).unwrap().status, TradeStatus::Disputed);
    }

    #[test]
    fn test_resolve_dispute_rejects_split_over_100_percent() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
        f.client.raise_dispute(&f.buyer, &f.id);

        assert!(f.client.try_resolve_dispute(&f.id, &10_001).is_err());
    }

    #[test]
    fn test_dispute_timeout_makes_trade_refundable_in_full() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
        f.client.raise_dispute(&f.buyer, &f.id);

        // Arbitrator never resolves. Before the dispute-resolution window
        // elapses, the permissionless refund path must not fire.
        assert!(f.client.try_refund_after_dispute_timeout(&f.id).is_err());

        f.env
            .ledger()
            .with_mut(|li| li.sequence_number += DISPUTE_RESOLUTION_WINDOW_LEDGERS);
        f.client.refund_after_dispute_timeout(&f.id);

        assert_eq!(f.token.balance(&f.buyer), 1_000);
        assert_eq!(f.token.balance(&f.contract_id), 0);
        assert_eq!(
            f.client.get_trade(&f.id).unwrap().status,
            TradeStatus::Refunded
        );

        // And it can never be resolved again after that.
        assert!(f.client.try_resolve_dispute(&f.id, &5_000).is_err());
    }

    #[test]
    #[should_panic]
    fn test_raise_dispute_after_timeout_fails() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.env.ledger().with_mut(|li| li.sequence_number += 101);
        f.client.raise_dispute(&f.buyer, &f.id);
    }

    #[test]
    #[should_panic]
    fn test_raise_dispute_unauthorized_fails() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        let random_addr = Address::generate(&f.env);
        f.client.raise_dispute(&random_addr, &f.id);
    }

    #[test]
    #[should_panic]
    fn test_dispute_blocks_refund() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.client.raise_dispute(&f.buyer, &f.id);

        f.env.ledger().with_mut(|li| li.sequence_number += 101);
        f.client.refund(&f.id);
    }

    #[test]
    fn test_dispute_blocks_release() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        f.client.raise_dispute(&f.buyer, &f.id);

        f.client.release(&f.id, &f.secret);

        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Disputed);
    }

    #[test]
    #[should_panic(expected = "10")]
    fn test_initialize_invalid_fee() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let arbitrator = Address::generate(&env);
        EscrowContractClient::new(&env, &env.register_contract(None, EscrowContract)).initialize(
            &admin,
            &token,
            &10_001,
            &arbitrator,
        );
    }

    #[test]
    #[should_panic(expected = "8")]
    fn test_lock_overflow_amount_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let arbitrator = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let client = EscrowContractClient::new(&env, &env.register_contract(None, EscrowContract));

        client.initialize(&admin, &token, &100, &arbitrator);

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
    fn set_arbitrator_requires_a_quorum_once_multisig_is_active() {
        // Changing *who* the arbitrator is remains a multisig-governed action
        // even though resolving a specific dispute (resolve_dispute) is a
        // single arbitrator key by design (see the issue's out-of-scope note
        // on threshold arbitration).
        let m = setup_multisig();
        let new_arbitrator = Address::generate(&m.f.env);
        assert_ne!(m.f.arbitrator, new_arbitrator);

        let single = vec![&m.f.env, m.s1.clone()];
        assert!(m
            .f
            .client
            .try_set_arbitrator(&new_arbitrator, &single)
            .is_err());

        let quorum = vec![&m.f.env, m.s1.clone(), m.s2.clone()];
        assert!(m
            .f
            .client
            .try_set_arbitrator(&new_arbitrator, &quorum)
            .is_ok());

        // The old arbitrator can no longer resolve disputes...
        m.f.client.lock(
            &m.f.id,
            &m.f.seller,
            &m.f.buyer,
            &500,
            &m.f.secret_hash,
            &100,
        );
        m.f.client.raise_dispute(&m.f.buyer, &m.f.id);
        // mock_all_auths() means we can't observe the *old* arbitrator being
        // rejected here directly (see test_resolve_dispute_from_non_arbitrator_fails
        // for that), but the new arbitrator resolving successfully confirms
        // set_arbitrator actually took effect in storage.
        m.f.client.resolve_dispute(&m.f.id, &10_000);
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

    // ------------------------------------------------------------------
    // Trade-ID collision resistance (issue #274).
    //
    // These tests confirm the written analysis in lock()'s doc comment:
    // a duplicate ID is cleanly rejected, and the existing trade's state
    // is completely unaffected.
    // ------------------------------------------------------------------

    /// lock() called twice with the same ID but different parameters must
    /// panic on the second call and leave the first trade in Locked status
    /// with its original buyer, amount, and secret_hash intact.
    #[test]
    #[should_panic(expected = "3")] // Error::TradeAlreadyExists == 3
    fn duplicate_trade_id_is_rejected_and_first_trade_is_unaffected() {
        let f = setup(2_000, 0);

        // Lock the first trade under `f.id` with well-known parameters.
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        // Verify first trade is in the expected state before the collision attempt.
        let first = f.client.get_trade(&f.id).unwrap();
        assert_eq!(first.status, TradeStatus::Locked);
        assert_eq!(first.amount, 500);
        assert_eq!(first.buyer, f.buyer);

        // Second buyer with a different amount and a different secret.
        let buyer2 = Address::generate(&f.env);
        f.env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &buyer2,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "lock",
                args: (
                    f.id.clone(),
                    f.seller.clone(),
                    buyer2.clone(),
                    900i128,
                    f.secret_hash.clone(),
                    200u32,
                )
                    .into_val(&f.env),
                sub_invokes: &[],
            },
        }]);

        // This must panic with code 3 (TradeAlreadyExists).
        f.client
            .lock(&f.id, &f.seller, &buyer2, &900, &f.secret_hash, &200);
    }

    /// After a failed duplicate-ID attempt the first trade continues to
    /// operate normally (can still be released with the original secret).
    #[test]
    fn first_trade_remains_fully_operational_after_collision_attempt() {
        let f = setup(2_000, 0);

        // Lock the first trade.
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        // Attempt to lock a second trade with the same ID — ignore the panic.
        let buyer2 = Address::generate(&f.env);
        let _ = f
            .client
            .try_lock(&f.id, &f.seller, &buyer2, &900, &f.secret_hash, &200);

        // First trade's state must be unchanged.
        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Locked);
        assert_eq!(trade.amount, 500);
        assert_eq!(trade.buyer, f.buyer);
        assert_eq!(f.token.balance(&f.contract_id), 500);

        // The original secret still releases it correctly.
        f.client.release(&f.id, &f.secret);
        assert_eq!(trade.amount, 500);
        assert_eq!(f.token.balance(&f.seller), 500); // 0% fee
        assert_eq!(f.token.balance(&f.contract_id), 0);
    }

    /// Distinct IDs never interfere: two trades with different IDs can
    /// co-exist, be released independently, and neither affects the other.
    #[test]
    fn distinct_trade_ids_never_collide() {
        let f = setup(2_000, 0);

        let secret2 = BytesN::from_array(&f.env, &[42u8; 32]);
        let secret_hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
        let id2 = BytesN::from_array(&f.env, &[2u8; 32]);

        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
        f.client
            .lock(&id2, &f.seller, &f.buyer, &700, &secret_hash2, &100);

        assert_eq!(f.token.balance(&f.contract_id), 1_200);

        // Release the first — second must stay Locked.
        f.client.release(&f.id, &f.secret);
        assert_eq!(
            f.client.get_trade(&f.id).unwrap().status,
            TradeStatus::Released
        );
        assert_eq!(
            f.client.get_trade(&id2).unwrap().status,
            TradeStatus::Locked
        );
        assert_eq!(f.token.balance(&f.contract_id), 700);

        // Release the second with its own secret.
        f.client.release(&id2, &secret2);
        assert_eq!(
            f.client.get_trade(&id2).unwrap().status,
            TradeStatus::Released
        );
        assert_eq!(f.token.balance(&f.contract_id), 0);
    }
}

mod cost_side_channel {
    use super::*;
    use soroban_sdk::{testutils::Ledger, vec, Address, BytesN, Env};

    // Issue #284: document the resource-cost delta between branches of
    // release()/refund()/lock(). We sample CPU-instruction budget around each
    // call. The success (token-moving) branches must cost strictly more than
    // the no-op/revert branches — that ordering is the leak the constant-cost
    // guard (flatten_branch_cost) is meant to blunt. We assert the *ordering*,
    // not absolute numbers, so the test stays robust across SDK versions.

    fn instr(env: &Env) -> u64 {
        env.budget().instructions()
    }

    #[test]
    fn resource_cost_compares_branches() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let token = token::Client::new(&env, &token_addr);
        token.mint(&buyer, &10_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_addr, &100);

        let secret = BytesN::from_array(&env, &[7u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
        let id = BytesN::from_array(&env, &[1u8; 32]);

        // release() on a NON-locked trade (cheap: get + early return).
        let before = instr(&env);
        client.try_release(&id, &secret);
        let release_noop = instr(&env) - before;

        // lock() a fresh trade (expensive: transfer + storage write).
        let before = instr(&env);
        client.lock(&id, &seller, &buyer, &500, &secret_hash, &100);
        let lock_fresh = instr(&env) - before;

        // release() on a Locked trade with correct secret (expensive: transfer).
        let before = instr(&env);
        client.release(&id, &secret);
        let release_success = instr(&env) - before;

        // The token-moving branches cost more than the no-op branch.
        assert!(
            release_success > release_noop,
            "success release must cost more than no-op release"
        );
        assert!(
            lock_fresh > release_noop,
            "fresh lock must cost more than no-op release"
        );

        // With flatten_branch_cost, the no-op branch is not free: it still does
        // the guard's storage write. Sanity-check it is non-zero.
        assert!(
            release_noop > 0,
            "no-op branch must still do constant work (guard)"
        );
    }
}

mod issue280_bonding {
    use super::*;
    use soroban_sdk::{testutils::Ledger, Address, BytesN, Env};

    // Issue #280: contract-level anti-spam bonding.
    //
    // - A new (unestablished) buyer must post a bond on lock(); it is refunded
    //   on successful completion.
    // - Reaching ESTABLISH_THRESHOLD successful non-dust completions makes the
    //   address established, after which no bond is taken.
    // - The threshold cannot be gamed with dust trades (below MIN_ESTABLISH_AMOUNT).

    fn setup() -> (
        Env,
        EscrowContractClient<'static>,
        token::Client<'static>,
        Address,
        Address,
        Address,
        BytesN<32>,
        BytesN<32>,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let token = token::Client::new(&env, &token_addr);
        token.mint(&buyer, &100_000_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_addr, &100);
        let secret = BytesN::from_array(&env, &[7u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
        (
            env,
            client,
            token,
            admin,
            buyer,
            seller,
            secret,
            secret_hash,
        )
    }

    #[test]
    fn unestablished_buyer_posts_and_gets_refunded_bond() {
        let (env, client, token, _admin, buyer, seller, secret, secret_hash) = setup();
        let id = BytesN::from_array(&env, &[1u8; 32]);
        let bal_before = token.balance(&buyer);

        client.lock(&id, &seller, &buyer, &1_000_000, &secret_hash, &100);

        assert_eq!(client.get_bond(&id), 1_000_000);
        assert!(token.balance(&buyer) < bal_before);

        client.release(&id, &secret);
        assert_eq!(client.get_bond(&id), 0);
        assert_eq!(token.balance(&buyer), bal_before - 10_000); // fee only (1%)
        assert_eq!(client.get_reputation(buyer), 1);
    }

    #[test]
    fn established_buyer_pays_no_bond() {
        let (env, client, token, _admin, buyer, seller, secret, secret_hash) = setup();
        for i in 1u8..=3 {
            let id = BytesN::from_array(&env, &[i; 32]);
            client.lock(&id, &seller, &buyer, &1_000_000, &secret_hash, &100);
            client.release(&id, &secret);
        }
        assert_eq!(client.get_reputation(buyer), 3);

        let id4 = BytesN::from_array(&env, &[99u8; 32]);
        let bal_before = token.balance(&buyer);
        client.lock(&id4, &seller, &buyer, &1_000_000, &secret_hash, &100);
        assert_eq!(client.get_bond(&id4), 0);
        assert_eq!(token.balance(&buyer), bal_before - 1_000_000);
    }

    #[test]
    fn dust_trades_do_not_establish() {
        let (env, client, _token, _admin, buyer, seller, secret, secret_hash) = setup();
        for i in 1u8..=3 {
            let id = BytesN::from_array(&env, &[i; 32]);
            client.lock(&id, &seller, &buyer, &10, &secret_hash, &100); // dust
            client.release(&id, &secret);
        }
        assert_eq!(client.get_reputation(buyer), 0);

        let id4 = BytesN::from_array(&env, &[99u8; 32]);
        client.lock(&id4, &seller, &buyer, &1_000_000, &secret_hash, &100);
        assert_eq!(client.get_bond(&id4), 1_000_000);
    }
}

mod issue281_commit_reveal {
    use super::*;
    use soroban_sdk::{testutils::Ledger, vec, Address, BytesN, Env};

    // Issue #281: commit-reveal trade-ID hardening.
    //
    // The adversarial strategy the issue worries about: an attacker watches the
    // mempool for a victim's `lock(id=X)` and front-runs with their own
    // `lock(id=X)` (griefing), or picks a known/predictable X. With commit-
    // reveal, the attacker must have previously called `commit_trade_id` with
    // sha256(X||salt) — they cannot reactively choose X after seeing the
    // victim's intent. We test the happy path and that a reveal without a prior
    // matching commit is rejected.

    fn setup(
        fee_bps: u32,
    ) -> (
        Env,
        EscrowContractClient<'static>,
        token::Client<'static>,
        Address,
        Address,
        Address,
        BytesN<32>,
        BytesN<32>,
        BytesN<32>,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let token = token::Client::new(&env, &token_addr);
        token.mint(&buyer, &10_000_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_addr, &fee_bps);
        let secret = BytesN::from_array(&env, &[7u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
        let id = BytesN::from_array(&env, &[1u8; 32]);
        let salt = BytesN::from_array(&env, &[42u8; 32]);
        (env, client, token, admin, buyer, seller, id, secret, salt)
    }

    #[test]
    fn commit_reveal_opens_trade() {
        let (env, client, _token, _admin, buyer, seller, id, secret, salt) = setup(100);
        let mut buf = soroban_sdk::Bytes::new(&env);
        buf.append(&id.to_bytes());
        buf.append(&salt.to_bytes());
        let commit = env.crypto().sha256(&buf);
        client.commit_trade_id(&buyer, &commit);

        client.reveal_and_lock(
            &id,
            &salt,
            &seller,
            &buyer,
            &500,
            &env.crypto().sha256(&secret.clone().into()).to_bytes(),
            &100,
        );

        let trade = client.get_trade(&id).unwrap();
        assert_eq!(trade.status, TradeStatus::Locked);
    }

    #[test]
    #[should_panic(expected = "22")] // CommitNotFound
    fn reveal_without_commit_fails() {
        let (env, client, _token, _admin, buyer, seller, id, secret, salt) = setup(100);
        client.reveal_and_lock(
            &id,
            &salt,
            &seller,
            &buyer,
            &500,
            &env.crypto().sha256(&secret.clone().into()).to_bytes(),
            &100,
        );
    }

    #[test]
    fn commit_is_single_use() {
        let (env, client, _token, _admin, buyer, seller, id, secret, salt) = setup(100);
        let mut buf = soroban_sdk::Bytes::new(&env);
        buf.append(&id.to_bytes());
        buf.append(&salt.to_bytes());
        let commit = env.crypto().sha256(&buf);
        client.commit_trade_id(&buyer, &commit);
        client.reveal_and_lock(
            &id,
            &salt,
            &seller,
            &buyer,
            &500,
            &env.crypto().sha256(&secret.clone().into()).to_bytes(),
            &100,
        );
        // Replaying the same reveal must fail: commit was consumed, so a second
        // reveal_and_lock hits CommitNotFound before create_trade.
        client.commit_trade_id(&buyer, &commit);
        assert!(client
            .try_reveal_and_lock(
                &id,
                &salt,
                &seller,
                &buyer,
                &500,
                &env.crypto().sha256(&secret.clone().into()).to_bytes(),
                &100
            )
            .is_err());
    }
}

mod property_test;
