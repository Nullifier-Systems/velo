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
    /// Append-only list of every address that has ever joined the
    /// permissionless arbitrator pool (order = join order, indices stable —
    /// entries are never removed, only deactivated via `ArbitratorMember`).
    ArbitratorPool,
    /// Per-arbitrator pool membership state, keyed by address. Distinct
    /// from the single `Arbitrator` above, which remains the fallback
    /// decision-maker for any dispute raised while the pool has no eligible
    /// member (e.g. before anyone has joined it).
    ArbitratorMember(Address),
    /// Pool-selection state for one disputed trade — which pool members
    /// were eligible, and (once drawn) who was selected.
    DisputeSelection(BytesN<32>),
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
    ArbitratorPoolFull = 22,
    ArbitratorAlreadyActive = 23,
    ArbitratorNotRegistered = 24,
    ArbitratorHasPendingDispute = 25,
    NoDisputeSelection = 26,
    SelectionNotReady = 27,
    /// `resolve_dispute()` was called for a trade whose pool draw hasn't
    /// happened yet — call `select_arbitrator()` first.
    ArbitratorSelectionPending = 28,
}

const DEFAULT_TIMEOUT_LEDGERS_MAX: u32 = 6 * 60 * 24 * 7;

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

/// How many ledgers an arbitrator must have been continuously active in the
/// pool before they count as eligible for a *newly raised* dispute. Ledgers
/// close roughly every 10s on this network (consistent with the ~week-long
/// `DEFAULT_TIMEOUT_LEDGERS_MAX` above), so this is roughly a day.
///
/// This is the primary defense against join-time gaming: eligibility for a
/// given dispute is decided from the pool as it stood a full activation
/// window in the past, so joining right after spotting a `lock()` you intend
/// to (or expect a colluding party to) dispute can never land you in that
/// dispute's draw. See docs/arbitrator-pool-selection.md.
const ARBITRATOR_ACTIVATION_LEDGERS: u32 = 6 * 60 * 24;

/// Ledgers to wait, after a dispute is raised, before `select_arbitrator()`
/// may draw the winner. Combined with the draw being a separate,
/// permissionless, one-shot call whose result never depends on the caller,
/// this decouples "who can trigger the draw" from "who can influence it" —
/// see docs/arbitrator-pool-selection.md for the full reasoning.
const ARBITRATOR_SELECTION_DELAY_LEDGERS: u32 = 6;

/// Bounds the arbitrator pool so building a per-dispute eligibility snapshot
/// (one storage read per pool member, done inside `raise_dispute()`) stays
/// well within Soroban's per-invocation compute budget. Mirrors
/// `MAX_BATCH_SIZE`'s rationale above.
const MAX_ARBITRATOR_POOL_SIZE: u32 = 64;

/// One entry in a `batch_release()` call: the trade to release and the
/// secret that unlocks it. Mirrors the arguments `release()` already takes,
/// just packaged so many can travel in one Soroban invocation.
#[derive(Clone)]
#[contracttype]
pub struct BatchReleaseItem {
    pub id: BytesN<32>,
    pub secret: BytesN<32>,
}

/// Per-arbitrator pool membership record.
#[derive(Clone)]
#[contracttype]
pub struct ArbitratorMeta {
    /// Ledger sequence at which this membership period began. Reset to the
    /// current ledger every time the arbitrator (re)joins, so a leave/rejoin
    /// cycle can never be used to shortcut the activation delay.
    pub joined_ledger: u32,
    /// Whether currently a member of the pool. `join_arbitrator_pool` /
    /// `leave_arbitrator_pool` toggle this; the address itself is never
    /// removed from `DataKey::ArbitratorPool` so pool indices stay stable.
    pub active: bool,
    /// Count of disputes currently assigned to this arbitrator that haven't
    /// been resolved or timed out yet. `leave_arbitrator_pool` refuses to
    /// let an arbitrator exit while this is nonzero, so a selected
    /// arbitrator can't dodge a dispute by leaving.
    pub pending_disputes: u32,
}

/// Pool-selection state for one disputed trade, created by `raise_dispute()`
/// and consumed by `select_arbitrator()` / `resolve_dispute()` /
/// `refund_after_dispute_timeout()`.
#[derive(Clone)]
#[contracttype]
pub struct DisputeSelection {
    /// Ledger sequence at which the dispute was raised — the point in time
    /// `eligible` was snapshotted from.
    pub raised_ledger: u32,
    /// `select_arbitrator()` only succeeds once the ledger has reached this
    /// sequence — see `ARBITRATOR_SELECTION_DELAY_LEDGERS`.
    pub reveal_ledger: u32,
    /// Arbitrators eligible for this specific dispute, frozen at
    /// `raised_ledger`. Empty means the pool had no eligible member when the
    /// dispute was raised — `resolve_dispute()` falls back to the single
    /// `DataKey::Arbitrator` for this trade, unchanged from before this pool
    /// existed.
    pub eligible: Vec<Address>,
    /// Filled in by `select_arbitrator()` once drawn. `None` until then.
    pub selected: Option<Address>,
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
    pub fn get_trade(env: Env, id: BytesN<32>) -> Option<TradeState> {
        env.storage().persistent().get(&DataKey::Trade(id))
    }

    /// Register as an arbitrator, joining the selection pool. Permissionless
    /// — anyone may call this for themselves, which is what makes the pool
    /// collusion-resistant: no admin gatekeeper decides who's eligible to be
    /// drawn. A freshly joined (or rejoined) arbitrator only becomes
    /// eligible for disputes raised at least `ARBITRATOR_ACTIVATION_LEDGERS`
    /// after this call — see that constant's doc comment for why.
    pub fn join_arbitrator_pool(env: Env, arbitrator: Address) -> Result<(), Error> {
        arbitrator.require_auth();

        let key = DataKey::ArbitratorMember(arbitrator.clone());
        if let Some(meta) = env
            .storage()
            .persistent()
            .get::<DataKey, ArbitratorMeta>(&key)
        {
            if meta.active {
                return Err(Error::ArbitratorAlreadyActive);
            }
            let meta = ArbitratorMeta {
                joined_ledger: env.ledger().sequence(),
                active: true,
                pending_disputes: meta.pending_disputes,
            };
            env.storage().persistent().set(&key, &meta);
            env.storage()
                .persistent()
                .extend_ttl(&key, 100_000, 100_000);

            env.events()
                .publish((symbol_short(&env, "arb_joined"),), arbitrator);
            return Ok(());
        }

        let mut pool: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::ArbitratorPool)
            .unwrap_or_else(|| Vec::new(&env));
        if pool.len() >= MAX_ARBITRATOR_POOL_SIZE {
            return Err(Error::ArbitratorPoolFull);
        }
        pool.push_back(arbitrator.clone());
        env.storage()
            .instance()
            .set(&DataKey::ArbitratorPool, &pool);

        let meta = ArbitratorMeta {
            joined_ledger: env.ledger().sequence(),
            active: true,
            pending_disputes: 0,
        };
        env.storage().persistent().set(&key, &meta);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 100_000);

        env.events()
            .publish((symbol_short(&env, "arb_joined"),), arbitrator);
        Ok(())
    }

    /// Leave the arbitrator pool. Requires that no dispute currently
    /// assigned to this arbitrator is still unresolved — otherwise an
    /// arbitrator could dodge a dispute they dislike the look of by leaving
    /// the instant they're drawn. Rejoining later resets the activation
    /// delay from scratch (see `join_arbitrator_pool`), so a leave/rejoin
    /// cycle can't be used to re-roll eligibility for a specific dispute.
    pub fn leave_arbitrator_pool(env: Env, arbitrator: Address) -> Result<(), Error> {
        arbitrator.require_auth();

        let key = DataKey::ArbitratorMember(arbitrator.clone());
        let mut meta: ArbitratorMeta = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ArbitratorNotRegistered)?;

        if !meta.active {
            return Err(Error::ArbitratorNotRegistered);
        }
        if meta.pending_disputes > 0 {
            return Err(Error::ArbitratorHasPendingDispute);
        }

        meta.active = false;
        env.storage().persistent().set(&key, &meta);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 100_000);

        env.events()
            .publish((symbol_short(&env, "arb_left"),), arbitrator);
        Ok(())
    }

    /// Draw the arbitrator for a disputed trade from the eligibility
    /// snapshot `raise_dispute()` recorded. Permissionless — anyone may call
    /// this once the reveal delay has passed, and the outcome never depends
    /// on who calls it. Idempotent: once a winner has been drawn, further
    /// calls just return it rather than redrawing (redrawing is what would
    /// let a caller "reroll" by resubmitting — see
    /// docs/arbitrator-pool-selection.md).
    pub fn select_arbitrator(env: Env, id: BytesN<32>) -> Result<Address, Error> {
        let key = DataKey::DisputeSelection(id.clone());
        let mut selection: DisputeSelection = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NoDisputeSelection)?;

        if let Some(existing) = selection.selected.clone() {
            return Ok(existing);
        }
        if selection.eligible.is_empty() {
            return Err(Error::NoDisputeSelection);
        }
        if env.ledger().sequence() < selection.reveal_ledger {
            return Err(Error::SelectionNotReady);
        }

        let len = selection.eligible.len() as u64;
        let index = env.prng().gen_range::<u64>(0..len);
        let winner = selection.eligible.get(index as u32).unwrap();

        selection.selected = Some(winner.clone());
        env.storage().persistent().set(&key, &selection);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 100_000);

        let meta_key = DataKey::ArbitratorMember(winner.clone());
        if let Some(mut meta) = env
            .storage()
            .persistent()
            .get::<DataKey, ArbitratorMeta>(&meta_key)
        {
            meta.pending_disputes += 1;
            env.storage().persistent().set(&meta_key, &meta);
            env.storage()
                .persistent()
                .extend_ttl(&meta_key, 100_000, 100_000);
        }

        env.events()
            .publish((symbol_short(&env, "arb_picked"), id), winner.clone());
        Ok(winner)
    }

    /// Read-only accessor for a dispute's pool-selection state.
    pub fn get_dispute_selection(env: Env, id: BytesN<32>) -> Option<DisputeSelection> {
        env.storage()
            .persistent()
            .get(&DataKey::DisputeSelection(id))
    }

    /// Read-only accessor for an arbitrator's pool membership state.
    pub fn get_arbitrator(env: Env, arbitrator: Address) -> Option<ArbitratorMeta> {
        env.storage()
            .persistent()
            .get(&DataKey::ArbitratorMember(arbitrator))
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

        // Snapshot arbitrator-pool eligibility now, before anyone can react
        // to this dispute existing. `resolve_dispute()` and
        // `select_arbitrator()` only ever consult this frozen snapshot, so
        // joining or leaving the pool after this point has zero effect on
        // this specific dispute. An empty snapshot (no eligible pool member)
        // means `resolve_dispute()` falls back to the single `Arbitrator`,
        // exactly as if this pool didn't exist.
        let now = env.ledger().sequence();
        let eligible = eligible_arbitrators(&env, now);
        let selection_key = DataKey::DisputeSelection(id.clone());
        let selection = DisputeSelection {
            raised_ledger: now,
            reveal_ledger: now + ARBITRATOR_SELECTION_DELAY_LEDGERS,
            eligible,
            selected: None,
        };
        env.storage().persistent().set(&selection_key, &selection);
        env.storage()
            .persistent()
            .extend_ttl(&selection_key, 100_000, 100_000);

        env.events()
            .publish((symbol_short(&env, "disputed"), id), (caller,));
    }

    /// Resolve a disputed trade by splitting the locked amount between buyer
    /// and seller. `buyer_share_bps` is the buyer's cut in basis points
    /// (0 = seller gets everything, minus the platform fee, exactly like
    /// `release()`; 10_000 = buyer gets a full refund, exactly like
    /// `refund()`; anything in between is a genuine partial split).
    ///
    /// Authorization: if the arbitrator pool had an eligible member when
    /// this dispute was raised, only the arbitrator drawn by
    /// `select_arbitrator()` for this specific trade may call this — not
    /// the single `Arbitrator`, not the admin, not the multisig. That's the
    /// entire point of a pool: resolution authority for a given dispute
    /// can't be a known-in-advance party. Otherwise (pool empty at raise
    /// time), falls back to the single `Arbitrator`, unchanged from before
    /// this pool existed.
    ///
    /// Callable only once per trade: after this call the trade is
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

        let selection_key = DataKey::DisputeSelection(id.clone());
        let selection: Option<DisputeSelection> = env.storage().persistent().get(&selection_key);
        let pool_active = matches!(&selection, Some(s) if !s.eligible.is_empty());

        if pool_active {
            let arbitrator = selection
                .unwrap()
                .selected
                .ok_or(Error::ArbitratorSelectionPending)?;
            arbitrator.require_auth();
            release_arbitrator_slot(&env, &arbitrator);
            env.storage().persistent().remove(&selection_key);
        } else {
            let arbitrator: Address = env
                .storage()
                .instance()
                .get(&DataKey::Arbitrator)
                .ok_or(Error::NotInitialized)?;
            arbitrator.require_auth();
            if selection.is_some() {
                env.storage().persistent().remove(&selection_key);
            }
        }

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

        // If the arbitrator pool had drawn a winner for this trade, free up
        // their pending-dispute slot and drop the selection record — an
        // unresponsive arbitrator isn't stuck any more than a responsive
        // one, and can still leave the pool afterward.
        let selection_key = DataKey::DisputeSelection(id.clone());
        if let Some(selection) = env
            .storage()
            .persistent()
            .get::<DataKey, DisputeSelection>(&selection_key)
        {
            if let Some(arbitrator) = selection.selected {
                release_arbitrator_slot(&env, &arbitrator);
            }
            env.storage().persistent().remove(&selection_key);
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

/// Builds the list of arbitrators eligible to be drawn for a dispute raised
/// at `at_ledger`: pool members who are currently active and who joined at
/// least `ARBITRATOR_ACTIVATION_LEDGERS` before `at_ledger`. Bounded by
/// `MAX_ARBITRATOR_POOL_SIZE` storage reads.
fn eligible_arbitrators(env: &Env, at_ledger: u32) -> Vec<Address> {
    let pool: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::ArbitratorPool)
        .unwrap_or_else(|| Vec::new(env));

    let mut eligible = Vec::new(env);
    for addr in pool.iter() {
        let meta: Option<ArbitratorMeta> = env
            .storage()
            .persistent()
            .get(&DataKey::ArbitratorMember(addr.clone()));
        if let Some(meta) = meta {
            if meta.active
                && meta
                    .joined_ledger
                    .saturating_add(ARBITRATOR_ACTIVATION_LEDGERS)
                    <= at_ledger
            {
                eligible.push_back(addr);
            }
        }
    }
    eligible
}

/// Frees up one pending-dispute slot for `arbitrator`, so `leave_arbitrator_pool`
/// stops refusing them once their draw is settled. Called from both
/// `resolve_dispute()` (on success) and `refund_after_dispute_timeout()` (on
/// an arbitrator who never resolved).
fn release_arbitrator_slot(env: &Env, arbitrator: &Address) {
    let meta_key = DataKey::ArbitratorMember(arbitrator.clone());
    if let Some(mut meta) = env
        .storage()
        .persistent()
        .get::<DataKey, ArbitratorMeta>(&meta_key)
    {
        meta.pending_disputes = meta.pending_disputes.saturating_sub(1);
        env.storage().persistent().set(&meta_key, &meta);
        env.storage()
            .persistent()
            .extend_ttl(&meta_key, 100_000, 100_000);
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
    // Permissionless, collusion-resistant arbitrator selection (issue #279).
    //
    // The pool is opt-in and layers on top of the single `Arbitrator`
    // resolution path added by issue #275: a deployment that never
    // populates a pool behaves exactly as the tests above already show
    // (resolve_dispute() gated by the single arbitrator). Once arbitrators
    // exist, `raise_dispute()` snapshots which of them are eligible
    // *before* anyone could react to the dispute existing, and
    // `select_arbitrator()` draws from that frozen snapshot only after a
    // delay. See docs/arbitrator-pool-selection.md for the full reasoning
    // behind why this is unpredictable and un-gameable at the moment it
    // matters.
    // ------------------------------------------------------------------

    struct ArbitratorPoolFixture {
        f: Fixture,
        a1: Address,
        a2: Address,
        a3: Address,
    }

    /// Three pool arbitrators, already past the activation delay, so
    /// they're eligible for whatever dispute a test raises next. `f`'s own
    /// single `arbitrator` (from `setup()`) still exists as the fallback
    /// for deployments/trades where the pool has no eligible member.
    fn setup_pool() -> ArbitratorPoolFixture {
        let f = setup(1_000, 100);
        let a1 = Address::generate(&f.env);
        let a2 = Address::generate(&f.env);
        let a3 = Address::generate(&f.env);
        f.client.join_arbitrator_pool(&a1);
        f.client.join_arbitrator_pool(&a2);
        f.client.join_arbitrator_pool(&a3);
        f.env
            .ledger()
            .with_mut(|li| li.sequence_number += ARBITRATOR_ACTIVATION_LEDGERS);
        ArbitratorPoolFixture { f, a1, a2, a3 }
    }

    #[test]
    fn raise_dispute_before_activation_delay_falls_back_to_single_arbitrator() {
        let f = setup(1_000, 100);
        let a1 = Address::generate(&f.env);
        f.client.join_arbitrator_pool(&a1);
        // No ledgers have passed since joining — a1 is not yet eligible.
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
        f.client.raise_dispute(&f.buyer, &f.id);

        let selection = f.client.get_dispute_selection(&f.id).unwrap();
        assert_eq!(selection.eligible.len(), 0);

        // Falls back to the single Arbitrator, exactly as before the pool
        // existed.
        f.client.resolve_dispute(&f.id, &10_000);
        assert_eq!(f.token.balance(&f.buyer), 1_000);
    }

    #[test]
    fn arbitrator_becomes_eligible_after_activation_delay() {
        let pool = setup_pool();
        pool.f.client.lock(
            &pool.f.id,
            &pool.f.seller,
            &pool.f.buyer,
            &500,
            &pool.f.secret_hash,
            &100,
        );
        pool.f.client.raise_dispute(&pool.f.buyer, &pool.f.id);

        let selection = pool.f.client.get_dispute_selection(&pool.f.id).unwrap();
        assert_eq!(selection.eligible.len(), 3);
    }

    #[test]
    fn select_arbitrator_fails_before_reveal_delay() {
        let pool = setup_pool();
        pool.f.client.lock(
            &pool.f.id,
            &pool.f.seller,
            &pool.f.buyer,
            &500,
            &pool.f.secret_hash,
            &100,
        );
        pool.f.client.raise_dispute(&pool.f.buyer, &pool.f.id);

        assert!(pool.f.client.try_select_arbitrator(&pool.f.id).is_err());
    }

    #[test]
    fn select_arbitrator_result_does_not_depend_on_caller_and_is_idempotent() {
        let pool = setup_pool();
        pool.f.client.lock(
            &pool.f.id,
            &pool.f.seller,
            &pool.f.buyer,
            &500,
            &pool.f.secret_hash,
            &100,
        );
        pool.f.client.raise_dispute(&pool.f.buyer, &pool.f.id);
        pool.f
            .env
            .ledger()
            .with_mut(|li| li.sequence_number += ARBITRATOR_SELECTION_DELAY_LEDGERS);

        // select_arbitrator() takes no caller/address argument at all, so
        // its outcome cannot structurally depend on who submits the call.
        let winner = pool.f.client.select_arbitrator(&pool.f.id);
        assert!(winner == pool.a1 || winner == pool.a2 || winner == pool.a3);

        // Calling again — as if a different, unrelated party raced to call
        // it too — must return the same address, never redraw. This is what
        // rules out grinding: there is no "reroll" to try for.
        let winner_again = pool.f.client.select_arbitrator(&pool.f.id);
        assert_eq!(winner, winner_again);
    }

    #[test]
    fn resolve_dispute_requires_a_draw_before_it_can_be_called() {
        let pool = setup_pool();
        pool.f.client.lock(
            &pool.f.id,
            &pool.f.seller,
            &pool.f.buyer,
            &500,
            &pool.f.secret_hash,
            &100,
        );
        pool.f.client.raise_dispute(&pool.f.buyer, &pool.f.id);

        // Arbitrator-pool mode is active (the eligible pool is non-empty)
        // but nobody has drawn a winner yet — resolve_dispute() must not
        // silently fall back to the single Arbitrator, which would defeat
        // collusion resistance.
        assert!(pool
            .f
            .client
            .try_resolve_dispute(&pool.f.id, &10_000)
            .is_err());
    }

    #[test]
    fn resolve_dispute_succeeds_once_the_drawn_arbitrator_calls_it() {
        let pool = setup_pool();
        pool.f.client.lock(
            &pool.f.id,
            &pool.f.seller,
            &pool.f.buyer,
            &500,
            &pool.f.secret_hash,
            &100,
        );
        pool.f.client.raise_dispute(&pool.f.buyer, &pool.f.id);
        pool.f
            .env
            .ledger()
            .with_mut(|li| li.sequence_number += ARBITRATOR_SELECTION_DELAY_LEDGERS);
        let winner = pool.f.client.select_arbitrator(&pool.f.id);
        assert!(winner == pool.a1 || winner == pool.a2 || winner == pool.a3);

        pool.f.client.resolve_dispute(&pool.f.id, &10_000);
        assert_eq!(pool.f.token.balance(&pool.f.buyer), 1_000);
        assert_eq!(
            pool.f.client.get_trade(&pool.f.id).unwrap().status,
            TradeStatus::Resolved
        );

        // Cleaned up, and the arbitrator is free to leave once their
        // pending count drops back to zero.
        assert!(pool.f.client.get_dispute_selection(&pool.f.id).is_none());
        let meta = pool.f.client.get_arbitrator(&winner).unwrap();
        assert_eq!(meta.pending_disputes, 0);
        assert!(pool.f.client.try_leave_arbitrator_pool(&winner).is_ok());
    }

    #[test]
    fn arbitrator_cannot_leave_pool_while_holding_a_pending_dispute() {
        let pool = setup_pool();
        pool.f.client.lock(
            &pool.f.id,
            &pool.f.seller,
            &pool.f.buyer,
            &500,
            &pool.f.secret_hash,
            &100,
        );
        pool.f.client.raise_dispute(&pool.f.buyer, &pool.f.id);
        pool.f
            .env
            .ledger()
            .with_mut(|li| li.sequence_number += ARBITRATOR_SELECTION_DELAY_LEDGERS);
        let winner = pool.f.client.select_arbitrator(&pool.f.id);

        assert!(pool.f.client.try_leave_arbitrator_pool(&winner).is_err());
    }

    #[test]
    fn dispute_timeout_frees_the_drawn_arbitrator_even_though_they_never_resolved() {
        let pool = setup_pool();
        pool.f.client.lock(
            &pool.f.id,
            &pool.f.seller,
            &pool.f.buyer,
            &500,
            &pool.f.secret_hash,
            &100,
        );
        pool.f.client.raise_dispute(&pool.f.buyer, &pool.f.id);
        pool.f
            .env
            .ledger()
            .with_mut(|li| li.sequence_number += ARBITRATOR_SELECTION_DELAY_LEDGERS);
        let winner = pool.f.client.select_arbitrator(&pool.f.id);

        pool.f
            .env
            .ledger()
            .with_mut(|li| li.sequence_number += DISPUTE_RESOLUTION_WINDOW_LEDGERS);
        pool.f.client.refund_after_dispute_timeout(&pool.f.id);

        assert_eq!(pool.f.token.balance(&pool.f.buyer), 1_000);
        assert_eq!(
            pool.f.client.get_trade(&pool.f.id).unwrap().status,
            TradeStatus::Refunded
        );

        // The selection record is cleaned up and the unresponsive
        // arbitrator is freed to leave the pool.
        assert!(pool.f.client.get_dispute_selection(&pool.f.id).is_none());
        let meta = pool.f.client.get_arbitrator(&winner).unwrap();
        assert_eq!(meta.pending_disputes, 0);
        assert!(pool.f.client.try_leave_arbitrator_pool(&winner).is_ok());
    }

    #[test]
    fn arbitrator_pool_full_rejects_further_joins() {
        let f = setup(1_000, 100);
        for _ in 0..MAX_ARBITRATOR_POOL_SIZE {
            let a = Address::generate(&f.env);
            f.client.join_arbitrator_pool(&a);
        }
        let one_too_many = Address::generate(&f.env);
        assert!(f.client.try_join_arbitrator_pool(&one_too_many).is_err());
    }

    #[test]
    fn leaving_and_rejoining_resets_the_activation_delay() {
        let f = setup(1_000, 100);
        let a1 = Address::generate(&f.env);
        f.client.join_arbitrator_pool(&a1);
        f.env
            .ledger()
            .with_mut(|li| li.sequence_number += ARBITRATOR_ACTIVATION_LEDGERS);
        f.client.leave_arbitrator_pool(&a1);
        f.client.join_arbitrator_pool(&a1);

        // Rejoined at the current (already-advanced) ledger, so a1 is not
        // eligible for a dispute raised immediately after rejoining — a
        // leave/rejoin cycle cannot be used to dodge the activation delay.
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
        f.client.raise_dispute(&f.buyer, &f.id);
        let selection = f.client.get_dispute_selection(&f.id).unwrap();
        assert_eq!(selection.eligible.len(), 0);
    }

    #[test]
    fn selection_covers_the_whole_pool_and_is_reasonably_uniform() {
        // Soroban's test-mode PRNG is deterministic per invocation order
        // (seeded to zero, then advanced by call order — see
        // soroban_sdk::prng's module docs), not truly random. That's fine
        // here: this test isn't re-verifying the network's CSPRNG, it's
        // checking that *this contract's* mapping from PRNG output to a
        // pool index doesn't introduce its own bias (e.g. an off-by-one
        // that starves the last index, or a modulo that favors low
        // indices). A real deployment draws on a consensus-seeded PRNG; see
        // docs/arbitrator-pool-selection.md.
        let f = setup(1_000_000, 0);
        let arbitrators: std::vec::Vec<Address> =
            (0..5).map(|_| Address::generate(&f.env)).collect();
        for a in arbitrators.iter() {
            f.client.join_arbitrator_pool(a);
        }
        f.env
            .ledger()
            .with_mut(|li| li.sequence_number += ARBITRATOR_ACTIVATION_LEDGERS);

        let mut counts: std::vec::Vec<u32> = std::vec::Vec::new();
        for _ in arbitrators.iter() {
            counts.push(0);
        }

        const TRIALS: u32 = 300;
        for i in 0..TRIALS {
            let mut id_bytes = [0u8; 32];
            id_bytes[0..4].copy_from_slice(&i.to_be_bytes());
            let trade_id = BytesN::from_array(&f.env, &id_bytes);

            let mut secret_bytes = [9u8; 32];
            secret_bytes[0..4].copy_from_slice(&i.to_be_bytes());
            let secret = BytesN::from_array(&f.env, &secret_bytes);
            let hash = f.env.crypto().sha256(&secret.into()).to_bytes();

            f.client
                .lock(&trade_id, &f.seller, &f.buyer, &1, &hash, &100);
            f.client.raise_dispute(&f.buyer, &trade_id);
            f.env
                .ledger()
                .with_mut(|li| li.sequence_number += ARBITRATOR_SELECTION_DELAY_LEDGERS);
            let winner = f.client.select_arbitrator(&trade_id);

            let idx = arbitrators.iter().position(|a| *a == winner).unwrap();
            counts[idx] += 1;
        }

        for (idx, count) in counts.iter().enumerate() {
            assert!(
                *count > 0,
                "arbitrator {idx} got zero selections across {TRIALS} disputes"
            );
            assert!(
                *count < TRIALS / 2,
                "arbitrator {idx} got a suspiciously large share: {count} of {TRIALS}"
            );
        }
    }
}

#[cfg(test)]
mod property_test;
