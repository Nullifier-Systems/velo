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

use htlc_core::{Htlc, TradeState, TradeStatus, Tranche};
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, token, Address, Bytes,
    BytesN, Env, Symbol, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArbitratorSet {
    pub keys: Vec<BytesN<32>>,
    pub threshold_epoch1: u32,
    pub threshold_epoch2: u32,
    pub t1_ledgers: u32,
    pub t2_ledgers: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeInfo {
    pub start_ledger: u32,
}

#[contracttype]
enum DataKey {
    Admin,
    PlatformFeeBps,
    Token,
    Trade(BytesN<32>),
    Signers,
    Threshold,
    /// Whether an admin has armed a pause (may still be in the delay window).
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
    /// Ledger sequence at which an armed pause becomes effective.
    PauseEffectiveLedger,
    ArbitratorSet,
    ArbitratorStake(Address),
    /// Dispute state information tracking when the dispute started.
    Dispute(BytesN<32>),
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
    /// MEV protection: pending commit-reveal escrow awaiting reveal.
    /// Stores CommitmentState keyed by commitment hash.
    Commitment(BytesN<32>),
    /// MEV protection: accumulated locked liquidity for dynamic fee calculation.
    LockedLiquidity,
    /// MEV protection: dynamic fee curve parameters (base fee, gamma, alpha, target).
    DynamicFeeConfig,
    /// Nonce tracking for replay protection.
    Nonce(BytesN<32>, u64),
    /// Trusted SEP-40-style price oracle contract (issue #334).
    OracleAddress,
    /// Maximum escrow USD value allowed at lock time, in oracle base units
    /// (same scale as `price / 10^decimals`). `0` disables the limit.
    MaxUsdLimit,
}

/// Ledgers that must elapse after `pause()` before `lock()` is rejected.
///
/// Long enough that a pause cannot front-run one specific pending lock in the
/// mempool; short enough to still act as a real emergency circuit breaker
/// (~50s at Stellar's ~5s ledger close time).
pub const PAUSE_DELAY_LEDGERS: u32 = 10;

/// Default TTL extension (in ledgers) for persistent storage entries during
/// active interactions. ~5.8 days at ~5s/ledger. Long enough for clients,
/// relayers, and reputation-scanners to observe terminal trade states, but
/// short enough that archived entries are eventually reclaimed.
const TTL_EXTEND: u32 = 100_000;

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
    EmptyBatch = 34,
    /// Commitment hash already exists (replay prevention).
    CommitmentAlreadyExists = 35,
    /// Commitment not found or already revealed/expired.
    CommitmentNotFound = 36,
    /// Reveal parameters don't match commitment hash.
    CommitmentMismatch = 37,
    /// Reveal window exceeded (Nmax blocks).
    RevealWindowClosed = 38,
    /// Reveal window not yet opened (Nmin blocks not reached).
    RevealWindowNotOpen = 39,
    /// Collateral bond forfeited due to expired commitment.
    CollateralForfeited = 40,
    /// Insufficient valid signatures provided for threshold validation.
    InsufficientSignatures = 41,
    /// Signature replay attempt detected (nonce already used).
    NonceAlreadyUsed = 42,
    /// Escrow USD value exceeds the configured maximum (issue #334).
    ExceedsMaxUsdLimit = 43,
    /// A USD limit is configured but no oracle address has been set.
    OracleNotConfigured = 44,
    /// Oracle returned no price or a non-positive price for the asset.
    PriceUnavailable = 45,
    /// Tranche amounts don't sum to the total locked amount.
    TrancheSumMismatch = 46,
    /// Attempted to release a tranche that was already released.
    TrancheAlreadyReleased = 47,
    /// Invalid tranche index (out of bounds).
    InvalidTrancheIndex = 48,
    /// Tranches array is empty — at least one tranche is required.
    NoTranches = 49,
    /// Multi-tranche trade detected — use release_tranche() instead of release().
    MultiTrancheUseReleaseTranche = 50,
}

const DEFAULT_TIMEOUT_LEDGERS_MAX: u32 = 6 * 60 * 24 * 7;

/// Issue #280 — anti-spam bonding constants.
const DEFAULT_BOND_AMOUNT: i128 = 1_000_000;
const ESTABLISH_THRESHOLD: i128 = 3;
const MIN_ESTABLISH_AMOUNT: i128 = 1_000_000;

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
/// MEV Protection: Commitment state in Phase 1 of commit-reveal protocol.
#[derive(Clone)]
#[contracttype]
pub struct CommitmentState {
    /// Buyer who committed funds and collateral bond.
    pub buyer: Address,
    /// Collateral amount (refunded on successful reveal, forfeited on expiry).
    pub collateral: i128,
    /// Trade amount locked.
    pub amount: i128,
    /// Ledger when commitment was created (for window enforcement).
    pub committed_at_ledger: u32,
    /// Reveal window must open after Nmin blocks.
    pub reveal_window_min_ledgers: u32,
    /// Reveal window must close before Nmax blocks (commits expire after this).
    pub reveal_window_max_ledgers: u32,
}

/// Dynamic fee curve parameters for MEV protection.
#[derive(Clone)]
#[contracttype]
pub struct DynamicFeeConfig {
    /// Base fee in basis points (bps). When L ≈ 0, fee = base_fee_bps.
    pub base_fee_bps: u32,
    /// Exponential factor γ in fee formula: Fee = base_fee × (1 + γ × (L/Ltarget)^α)
    /// Stored as fixed-point (10000 = 1.0) to avoid floats.
    pub gamma_fp: u32,
    /// Exponent α in fee formula.
    pub alpha: u32,
    /// Target liquidity threshold (in stroops) — threshold for fee curve inflection.
    pub target_liquidity: i128,
}

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

/// Issue #280 — tunable anti-spam bond parameters.
#[derive(Clone)]
#[contracttype]
pub struct BondParams {
    pub bond_amount: i128,
    pub establish_threshold: i128,
    pub min_establish_amount: i128,
}

/// SEP-40-compatible asset identifier for oracle price lookups (issue #334).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}

/// Most recent oracle quote for an asset (issue #334).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// Client interface for a trusted USD price oracle (SEP-40-shaped).
#[contractclient(name = "PriceOracleClient")]
pub trait PriceOracle {
    fn decimals(env: Env) -> u32;
    fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData>;
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
            bond_amount: 0,
            establish_threshold: ESTABLISH_THRESHOLD,
            min_establish_amount: MIN_ESTABLISH_AMOUNT,
        })
}

// Invariant: funds can only ever leave this contract's balance through
// the gated exit paths below, each checked against `status`:
//   - release() / batch_release() / release_batch()  require status == Locked
//   - refund()                                       requires status == Locked
//   - resolve_dispute()                              requires status == Disputed
//   - fallback_after_timeout()                       requires status == Disputed
// Every exit path flips `status` away from its required starting value
// *before* any token transfer (CEI). Inflows (`lock`, `commit_escrow`,
// `reveal_escrow`, `stake_arbitrator`) likewise write bookkeeping before
// calling `transfer`, so a hypothetical reentrant token callback would
// already observe the updated state. Soroban currently rejects contract
// re-entry at the host ("Contract re-entry is not allowed"); combined with
// invocation atomicity, a trapping transfer rolls back any status flip in
// the same call. See docs/escrow-sep41-reentrancy-audit.md (issue #273).
#[contract]
pub struct EscrowContract;

/// Window constraints for commit-reveal protocol (MEV protection).
/// Reveal must open after Nmin blocks and close before Nmax blocks.
const COMMIT_REVEAL_WINDOW_MIN_LEDGERS: u32 = 2; // ~10 seconds (2 ledgers)
const COMMIT_REVEAL_WINDOW_MAX_LEDGERS: u32 = 100; // ~15 minutes (same as lock timeout for P2P)

/// Collateral multiplier: bond required to make commit is % of trade amount.
/// Stored as fixed-point (10000 = 100%, 500 = 5%).
const COMMIT_COLLATERAL_RATE_FP: u32 = 500; // 5% collateral requirement

/// Default dynamic fee configuration.
/// Prevents transaction spam when pending escrow volume is high.
const DEFAULT_DYNAMIC_FEE_BASE_BPS: u32 = 100; // 1% base fee
const DEFAULT_DYNAMIC_FEE_GAMMA_FP: u32 = 2000; // γ = 0.2 (fixed-point)
const DEFAULT_DYNAMIC_FEE_ALPHA: u32 = 2; // α = 2 (quadratic)
const DEFAULT_DYNAMIC_FEE_TARGET_LIQUIDITY: i128 = 1_000_000_000_000; // 10M USDC target

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
        arbitrator_set: ArbitratorSet,
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
        // Circuit breaker defaults off — new locks are allowed until admin arms a pause.
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&DataKey::ArbitratorSet, &arbitrator_set);
        Ok(())
    }

    /// Replace the arbitrator address. Gated by single admin or multisig,
    /// same as the other admin-governance setters — this changes *who*
    /// decides disputes, not the outcome of any specific dispute.
    pub fn set_arbitrator_set(
        env: Env,
        arbitrator_set: ArbitratorSet,
        signers: Vec<Address>,
    ) -> Result<(), Error> {
        require_multisig(&env, &signers)?;
        env.storage()
            .instance()
            .set(&DataKey::ArbitratorSet, &arbitrator_set);
        Ok(())
    }

    /// Set the fallback single-arbitrator address used when the permissionless
    /// pool has no eligible member for a dispute.
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

    /// Allows an arbitrator to lock collateral to participate in dispute resolution.
    /// This bond is slashed if the arbitrator fails to act during their assigned epoch.
    pub fn stake_arbitrator(env: Env, arbitrator: Address, amount: i128) {
        arbitrator.require_auth();
        if amount <= 0 {
            panic_with_error(&env, Error::InvalidAmount);
        }
        // CEI (issue #273): credit stake bookkeeping before the external pull.
        let key = DataKey::ArbitratorStake(arbitrator.clone());
        let current_stake: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&key, &(current_stake + amount));

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        client.transfer(&arbitrator, &env.current_contract_address(), &amount);
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
    }
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
                // CEI (issue #273): clear bond bookkeeping before the refund transfer.
                env.storage().instance().remove(&DataKey::Bond(id.clone()));
                let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
                let client = token::Client::new(env, &token_addr);
                client.transfer(&env.current_contract_address(), buyer, &bond);
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

    /// Whether `lock()` is currently rejected (pause armed and delay elapsed).
    pub fn is_paused(env: Env) -> bool {
        is_effectively_paused(&env)
    }

    /// Ledger at which a scheduled pause becomes effective, or `None` if no
    /// pause is armed.
    pub fn pause_effective_ledger(env: Env) -> Option<u32> {
        let armed: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if !armed {
            return None;
        }
        env.storage().instance().get(&DataKey::PauseEffectiveLedger)
    }

    /// Fixed delay (in ledgers) between `pause()` and effective lock blocking.
    pub fn pause_delay_ledgers(_env: Env) -> u32 {
        PAUSE_DELAY_LEDGERS
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
    pub fn dispute(env: Env, caller: Address, id: BytesN<32>) {
        Self::raise_dispute(env, caller, id);
    }

    pub fn raise_dispute(env: Env, caller: Address, id: BytesN<32>) {
        check_not_paused(&env);
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
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);

        let info = DisputeInfo {
            start_ledger: env.ledger().sequence(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Dispute(id.clone()), &info);
        env.storage().persistent().extend_ttl(
            &DataKey::Dispute(id.clone()),
            TTL_EXTEND,
            TTL_EXTEND,
        );

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
    pub fn resolve_dispute(
        env: Env,
        id: BytesN<32>,
        buyer_share_bps: u32,
        signatures: Vec<(u32, BytesN<64>)>,
    ) -> Result<(), Error> {
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
        let arb_set: ArbitratorSet = env
            .storage()
            .instance()
            .get(&DataKey::ArbitratorSet)
            .ok_or(Error::NotInitialized)?;

        let dispute_info: DisputeInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(id.clone()))
            .ok_or(Error::TradeNotDisputed)?;

        let elapsed = env
            .ledger()
            .sequence()
            .saturating_sub(dispute_info.start_ledger);

        if elapsed > arb_set.t2_ledgers {
            return Err(Error::TimeoutReached); // Should use fallback
        }

        let required_sigs = if elapsed <= arb_set.t1_ledgers {
            arb_set.threshold_epoch1
        } else {
            arb_set.threshold_epoch2
        };

        if signatures.len() < required_sigs {
            return Err(Error::Unauthorized);
        }

        let mut msg_buf = BytesN::<32>::from_array(&env, &[0; 32]); // placeholder for proper hashing of payload
        let mut verified_count = 0;
        let mut seen_indices = Vec::new(&env);

        for sig in signatures.iter() {
            let (idx, signature) = sig;
            if seen_indices.contains(idx) {
                continue;
            }
            seen_indices.push_back(idx);

            if let Some(pub_key) = arb_set.keys.get(idx) {
                env.crypto()
                    .ed25519_verify(&pub_key, &msg_buf.clone().into(), &signature);
                verified_count += 1;
            }
        }

        if verified_count < required_sigs {
            return Err(Error::Unauthorized);
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
            .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);
        env.storage()
            .persistent()
            .remove(&DataKey::Dispute(id.clone()));

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

    pub fn refund_after_dispute_timeout(env: Env, id: BytesN<32>) -> Result<(), Error> {
        Self::fallback_after_timeout(env, id)
    }

    /// Permissionless fallback: if a dispute sits unresolved past its
    /// `DisputeDeadline`, anyone may return the full locked amount to the
    /// buyer. This mirrors `refund()`'s permissionless-after-timeout design
    /// so an unresponsive (or compromised) arbitrator can never freeze funds.
    pub fn fallback_after_timeout(env: Env, id: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if state.status != TradeStatus::Disputed {
            return Err(Error::TradeNotDisputed);
        }

        let dispute_info: DisputeInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(id.clone()))
            .ok_or(Error::TradeNotDisputed)?;

        let arb_set: ArbitratorSet = env
            .storage()
            .instance()
            .get(&DataKey::ArbitratorSet)
            .ok_or(Error::NotInitialized)?;

        let elapsed = env
            .ledger()
            .sequence()
            .saturating_sub(dispute_info.start_ledger);
        if elapsed <= arb_set.t2_ledgers {
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
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);
        env.storage()
            .persistent()
            .remove(&DataKey::Dispute(id.clone()));

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

    /// Arm the emergency pause circuit breaker (admin / multisig only).
    ///
    /// The pause does **not** take effect immediately: `lock()` keeps working
    /// until `PAUSE_DELAY_LEDGERS` have elapsed, so pause cannot be used to
    /// front-run and block a specific pending transaction. Once effective,
    /// only new locks are rejected — see the comment on `release`/`refund`.
    pub fn pause(env: Env, signers: Vec<Address>) -> Result<(), Error> {
        require_multisig(&env, &signers)?;
        let effective = env.ledger().sequence().saturating_add(PAUSE_DELAY_LEDGERS);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage()
            .instance()
            .set(&DataKey::PauseEffectiveLedger, &effective);
        Ok(())
    }

    /// Cancel a pending or active pause, restoring normal `lock()` operation.
    pub fn unpause(env: Env, signers: Vec<Address>) -> Result<(), Error> {
        require_multisig(&env, &signers)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .remove(&DataKey::PauseEffectiveLedger);
        Ok(())
    }

    /// Set the trusted oracle contract used for USD conversion (issue #334).
    /// Gated by single admin or multisig, same as other governance setters.
    pub fn set_oracle_address(
        env: Env,
        oracle: Address,
        signers: Vec<Address>,
    ) -> Result<(), Error> {
        require_multisig(&env, &signers)?;
        env.storage()
            .instance()
            .set(&DataKey::OracleAddress, &oracle);
        Ok(())
    }

    /// Set the maximum USD value allowed per escrow lock (issue #334).
    /// Denominated in oracle base units (`price / 10^decimals`). Pass `0` to
    /// disable the limit. Negative values are rejected.
    pub fn set_max_usd_limit(
        env: Env,
        max_usd_limit: i128,
        signers: Vec<Address>,
    ) -> Result<(), Error> {
        require_multisig(&env, &signers)?;
        if max_usd_limit < 0 {
            return Err(Error::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::MaxUsdLimit, &max_usd_limit);
        Ok(())
    }

    /// Current oracle contract address, if configured.
    pub fn get_oracle_address(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::OracleAddress)
    }

    /// Current max USD escrow limit (`0` = unlimited / unset).
    pub fn get_max_usd_limit(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MaxUsdLimit)
            .unwrap_or(0)
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
        Self::flatten_branch_cost(&env);
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
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);

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

    /// Atomically releases `release_trade_id` and re-locks the payout it
    /// would have paid out directly into a brand-new trade, instead of
    /// transferring it to a wallet first. This is how a cash provider who
    /// just received funds in one trade re-circulates that same value into
    /// a new trade without it ever sitting outside the contract.
    ///
    /// # Authorization
    ///
    /// Plain `release()` is permissionless: whoever supplies the correct
    /// `secret` triggers payout to `release_trade_id`'s `seller`, no matter
    /// who calls it. Chaining is a materially different action — it
    /// redirects that same payout into a *new* trade of the caller's
    /// choosing (a different counterparty, secret hash and timeout) rather
    /// than paying it to the wallet the seller expects. That decision
    /// belongs only to the party the funds are owed to, so this function
    /// requires `seller.require_auth()` in addition to the secret check.
    /// Without that, anyone who merely observed `release_secret` (e.g. by
    /// watching it get revealed at hand-off) could hijack someone else's
    /// incoming payout into a trade they control — exactly the redirection
    /// this gate exists to prevent.
    ///
    /// `release_trade_id`'s `buyer` needs no additional say here: from
    /// their point of view chaining is indistinguishable from an ordinary
    /// `release()` — the same secret is checked against the same hash and
    /// their trade ends up `Released` either way. The new trade's `buyer`
    /// is always `release_trade_id`'s `seller` (the party recirculating
    /// its own incoming funds); `new_seller` is the counterparty they're
    /// choosing for the new trade.
    ///
    /// Returns the new trade's id, deterministically derived from
    /// `release_trade_id` and `new_secret_hash` so callers can look it up
    /// without the contract needing an extra explicit id argument.
    pub fn chain_release_to_lock(
        env: Env,
        release_trade_id: BytesN<32>,
        release_secret: BytesN<32>,
        new_seller: Address,
        new_secret_hash: BytesN<32>,
        new_timeout_ledgers: u32,
    ) -> Result<BytesN<32>, Error> {
        check_not_paused(&env);

        let release_key = DataKey::Trade(release_trade_id.clone());
        let mut release_state: TradeState = env
            .storage()
            .persistent()
            .get(&release_key)
            .ok_or(Error::TradeNotFound)?;

        if release_state.status != TradeStatus::Locked {
            return Err(Error::TradeNotLocked);
        }

        let computed = env.crypto().sha256(&release_secret.into());
        if computed.to_bytes() != release_state.secret_hash {
            return Err(Error::InvalidSecret);
        }

        // Only the party a plain release() would have paid may redirect
        // that payout into a new trade instead of their wallet — see the
        // Authorization section in the doc comment above.
        release_state.seller.require_auth();

        if new_timeout_ledgers == 0 || new_timeout_ledgers > DEFAULT_TIMEOUT_LEDGERS_MAX {
            return Err(Error::InvalidTimeout);
        }

        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(0);
        let fee = (release_state.amount * fee_bps as i128) / 10_000;
        let payout = release_state.amount - fee;
        if payout <= 0 {
            return Err(Error::InvalidAmount);
        }

        let new_id = chained_trade_id(&env, &release_trade_id, &new_secret_hash);
        let new_key = DataKey::Trade(new_id.clone());
        if env.storage().persistent().has(&new_key) {
            return Err(Error::TradeAlreadyExists);
        }

        // CEI pattern: both trades' state is finalized before the only
        // external transfer this call makes (the platform fee, if any).
        // The payout itself never leaves the contract's token balance — it
        // simply becomes the new trade's escrowed amount instead of an
        // outbound transfer to release_state.seller's wallet, which is the
        // property this function exists to provide.
        release_state.status = TradeStatus::Released;
        env.storage().persistent().set(&release_key, &release_state);
        env.storage()
            .persistent()
            .extend_ttl(&release_key, TTL_EXTEND, TTL_EXTEND);

        let new_timeout_ledger = env.ledger().sequence() + new_timeout_ledgers;

        // Create a single-tranche trade for the chained lock
        let mut new_tranches = Vec::new(&env);
        new_tranches.push_back(Tranche {
            amount: payout,
            secret_hash: new_secret_hash.clone(),
            released: false,
        });

        let new_state = TradeState {
            seller: new_seller,
            buyer: release_state.seller.clone(),
            amount: payout,
            secret_hash: new_secret_hash,
            tranches: new_tranches,
            timeout_ledger: new_timeout_ledger,
            status: TradeStatus::Locked,
        };
        env.storage().persistent().set(&new_key, &new_state);
        env.storage()
            .persistent()
            .extend_ttl(&new_key, 100_000, 100_000);

        if fee > 0 {
            let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
            let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
            let client = token::Client::new(&env, &token_addr);
            client.transfer(&env.current_contract_address(), &admin, &fee);
        }

        // Two distinguishable events rather than "released" + "locked" —
        // off-chain systems need to tell a chained operation apart from
        // two independent ones. Each cross-references the other trade's
        // id so a listener can reconstruct the link from either event.
        env.events().publish(
            (symbol_short(&env, "chain_rel"), release_trade_id),
            (new_id.clone(), payout),
        );
        env.events()
            .publish((symbol_short(&env, "chain_lock"), new_id.clone()), payout);

        Ok(new_id)
    }

    /// Atomically release multiple trades in a single transaction.
    /// ALL trades must be valid (exist, Locked, correct secrets) or the
    /// ENTIRE batch fails and reverts — no partial settlement.
    /// This provides atomicity unlike batch_release, at the cost of
    /// rejecting the batch if ANY single secret is invalid.
    pub fn release_batch(env: Env, releases: Vec<BatchReleaseItem>) -> Result<(), Error> {
        check_not_paused(&env);
        Self::flatten_branch_cost(&env);

        if releases.is_empty() {
            return Err(Error::EmptyBatch);
        }

        if releases.len() > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }

        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(0);

        // === VALIDATION PHASE ===
        // Verify ALL trades exist, are Locked, and have matching secrets
        // BEFORE making any state changes. If ANY check fails, the entire
        // batch reverts — this is the atomic guarantee.
        for item in releases.iter() {
            let key = DataKey::Trade(item.id.clone());
            let state: TradeState = match env.storage().persistent().get(&key) {
                Some(s) => s,
                None => return Err(Error::InvalidSecret), // Trade doesn't exist
            };

            if state.status != TradeStatus::Locked {
                return Err(Error::InvalidSecret); // Trade not in Locked state
            }

            let computed = env.crypto().sha256(&item.secret.clone().into());
            if computed.to_bytes() != state.secret_hash {
                return Err(Error::InvalidSecret); // Secret mismatch
            }
        }

        // === EXECUTION PHASE ===
        // All validations passed; execute all releases atomically.
        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        let client = token::Client::new(&env, &token_addr);

        for item in releases.iter() {
            let key = DataKey::Trade(item.id.clone());
            let mut state: TradeState = env.storage().persistent().get(&key).unwrap();

            let fee = (state.amount * fee_bps as i128) / 10_000;
            let payout = state.amount - fee;

            // CEI pattern: update state before external calls.
            state.status = TradeStatus::Released;
            env.storage().persistent().set(&key, &state);
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);

            client.transfer(&env.current_contract_address(), &state.seller, &payout);
            if fee > 0 {
                client.transfer(&env.current_contract_address(), &admin, &fee);
            }

            env.events()
                .publish((symbol_short(&env, "released"), item.id.clone()), payout);
        }

        Ok(())
    }

    /// MEV Protection: Phase 1 — Commit escrow creation.
    /// Buyer submits cryptographic commitment: SHA256(buyer || seller || amount || secret_hash || salt)
    /// along with collateral bond (% of trade amount).
    ///
    /// Commitment is locked in storage. Reveal must happen within [Nmin, Nmax] blocks.
    /// After Nmax blocks, commitment expires and collateral is forfeited to fee pool.
    pub fn commit_escrow(
        env: Env,
        buyer: Address,
        commitment_hash: BytesN<32>, // SHA256(buyer || seller || amount || secret_hash || salt)
        amount: i128,                // Trade amount (not the commitment hash)
    ) -> Result<(), Error> {
        check_not_paused(&env);
        Self::flatten_branch_cost(&env);

        // Buyer must authorize spending collateral
        // let buyer = env.invoker();
        buyer.require_auth();

        if amount <= 0 || amount > (i128::MAX / 10_000) {
            return Err(Error::InvalidAmount);
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)?;

        // Issue #334: same USD cap as `lock` — reject oversized commitments early.
        enforce_max_usd_limit(&env, &token_addr, amount);

        // Check commitment doesn't already exist (replay prevention)
        let commitment_key = DataKey::Commitment(commitment_hash.clone().into());
        if env.storage().persistent().has(&commitment_key) {
            return Err(Error::CommitmentAlreadyExists);
        }

        // Calculate collateral bond (5% of amount)
        let collateral = (amount * COMMIT_COLLATERAL_RATE_FP as i128) / 10_000;

        // CEI (issue #273): record commitment + liquidity bookkeeping before pull.
        let commitment_state = CommitmentState {
            buyer: buyer.clone(),
            collateral,
            amount,
            committed_at_ledger: env.ledger().sequence(),
            reveal_window_min_ledgers: COMMIT_REVEAL_WINDOW_MIN_LEDGERS,
            reveal_window_max_ledgers: COMMIT_REVEAL_WINDOW_MAX_LEDGERS,
        };

        env.storage()
            .persistent()
            .set(&commitment_key, &commitment_state);
        env.storage().persistent().extend_ttl(
            &commitment_key,
            COMMIT_REVEAL_WINDOW_MAX_LEDGERS + 100,
            COMMIT_REVEAL_WINDOW_MAX_LEDGERS + 100,
        );

        let current_liquidity: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LockedLiquidity)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::LockedLiquidity, &(current_liquidity + amount));

        let client = token::Client::new(&env, &token_addr);
        client.transfer(&buyer, &env.current_contract_address(), &collateral);

        env.events()
            .publish((symbol_short(&env, "commit"), commitment_hash), amount);

        Ok(())
    }

    /// MEV Protection: Phase 2 — Reveal and complete escrow creation.
    /// Buyer reveals cleartext parameters. Contract verifies commitment hash matches,
    /// transfers collateral + amount to escrow, and proceeds with standard lock.
    pub fn reveal_escrow(
        env: Env,
        buyer: Address,
        id: BytesN<32>, // Trade ID for the final escrow
        seller: Address,
        amount: i128,
        secret_hash: BytesN<32>,
        salt: BytesN<32>, // Commitment salt (reveals hash = SHA256(buyer || seller || ...))
        timeout_ledgers: u32,
    ) -> Result<(), Error> {
        check_not_paused(&env);
        Self::flatten_branch_cost(&env);

        // let buyer = env.invoker();
        buyer.require_auth();

        // Recompute commitment hash from parameters
        let commitment_input = (
            buyer.clone(),
            seller.clone(),
            amount,
            secret_hash.clone(),
            salt,
        );
        let serialized = env.crypto().sha256(&commitment_input.to_xdr(&env));
        let commitment_hash = serialized.clone();

        // Fetch commitment state
        let commitment_key = DataKey::Commitment(commitment_hash.clone().into());
        let commitment_state: CommitmentState = env
            .storage()
            .persistent()
            .get(&commitment_key)
            .ok_or(Error::CommitmentNotFound)?;

        // Verify commitment hasn't expired
        let current_ledger = env.ledger().sequence();
        let committed_at = commitment_state.committed_at_ledger;
        let reveal_deadline = committed_at + commitment_state.reveal_window_max_ledgers;

        if current_ledger >= reveal_deadline {
            // Commitment expired — collateral is forfeited
            env.storage().persistent().remove(&commitment_key);

            // Remove from liquidity tracking
            let current_liquidity: i128 = env
                .storage()
                .instance()
                .get(&DataKey::LockedLiquidity)
                .unwrap_or(0);
            env.storage().instance().set(
                &DataKey::LockedLiquidity,
                &(current_liquidity
                    .saturating_sub(commitment_state.amount)
                    .max(0)),
            );

            return Err(Error::RevealWindowClosed);
        }

        // Verify reveal window is open (Nmin has passed)
        let reveal_open_at = committed_at + commitment_state.reveal_window_min_ledgers;
        if current_ledger < reveal_open_at {
            return Err(Error::RevealWindowNotOpen);
        }

        // Verify revealed parameters match commitment
        if commitment_state.amount != amount
            || commitment_state.buyer != buyer
            || commitment_state.collateral != (amount * COMMIT_COLLATERAL_RATE_FP as i128) / 10_000
        {
            return Err(Error::CommitmentMismatch);
        }

        // Proceed with standard lock (equivalent to original lock() path)
        if timeout_ledgers == 0 || timeout_ledgers > DEFAULT_TIMEOUT_LEDGERS_MAX {
            return Err(Error::InvalidTimeout);
        }

        let key = DataKey::Trade(id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::TradeAlreadyExists);
        }

        let timeout_ledger = current_ledger + timeout_ledgers;

        // Create a single-tranche trade for backward compatibility
        let mut tranches = Vec::new(&env);
        tranches.push_back(Tranche {
            amount,
            secret_hash: secret_hash.clone(),
            released: false,
        });

        let state = TradeState {
            seller,
            buyer: buyer.clone(),
            amount,
            secret_hash,
            tranches,
            timeout_ledger,
            status: TradeStatus::Locked,
        };

        // CEI (issue #273): lock trade + clear commitment before token movements.
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 100_000);
        env.storage().persistent().remove(&commitment_key);

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)?;

        let client = token::Client::new(&env, &token_addr);

        // Transfer trade amount (collateral is already escrowed)
        client.transfer(&buyer, &env.current_contract_address(), &amount);

        // Refund collateral to buyer (reveal succeeded)
        client.transfer(
            &env.current_contract_address(),
            &buyer,
            &commitment_state.collateral,
        );

        // Note: LockedLiquidity already incremented during commit; stays until release/refund
        // (This will be decremented separately in release/refund logic if implemented)

        env.events()
            .publish((symbol_short(&env, "reveal"), id), amount);

        Ok(())
    }

    /// Multi-Party Threshold Signature (2-of-3) Escrow Release Validation.
    /// Releases escrowed funds if at least 2 valid Ed25519 signatures from the designated
    /// authorized public keys (buyer, seller, arbitrator) are provided.
    pub fn release_escrow(
        env: Env,
        escrow_id: BytesN<32>,
        release_amount: i128,
        recipient_address: Address,
        nonce: u64,
        designated_keys: Vec<BytesN<32>>,
        signatures: Vec<(BytesN<32>, BytesN<64>)>,
    ) -> Result<(), Error> {
        check_not_paused(&env);
        Self::flatten_branch_cost(&env);

        let nonce_key = DataKey::Nonce(escrow_id.clone(), nonce);
        if env.storage().persistent().has(&nonce_key) {
            return Err(Error::NonceAlreadyUsed);
        }

        if signatures.len() < 2 {
            return Err(Error::InsufficientSignatures);
        }

        let payload_input = (
            escrow_id.clone(),
            release_amount,
            recipient_address.clone(),
            nonce,
        );
        let payload = env.crypto().sha256(&payload_input.to_xdr(&env));

        let mut valid_count = 0;
        let mut seen_keys = Vec::new(&env);

        for sig in signatures.iter() {
            let (pub_key, signature) = sig;
            if !designated_keys.contains(&pub_key) {
                continue;
            }
            if seen_keys.contains(&pub_key) {
                continue;
            }
            seen_keys.push_back(pub_key.clone());

            env.crypto()
                .ed25519_verify(&pub_key, &payload.clone().into(), &signature);
            valid_count += 1;
        }

        if valid_count < 2 {
            return Err(Error::InsufficientSignatures);
        }

        env.storage().persistent().set(&nonce_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&nonce_key, TTL_EXTEND, TTL_EXTEND);

        let key = DataKey::Trade(escrow_id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if state.status != TradeStatus::Locked {
            return Err(Error::TradeNotLocked);
        }
        if state.amount != release_amount {
            return Err(Error::InvalidAmount);
        }

        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(0);
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)?;

        let fee = (state.amount * fee_bps as i128) / 10_000;
        let payout = state.amount - fee;

        state.status = TradeStatus::Released;
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);

        let client = token::Client::new(&env, &token_addr);
        client.transfer(&env.current_contract_address(), &recipient_address, &payout);
        if fee > 0 {
            client.transfer(&env.current_contract_address(), &admin, &fee);
        }

        // Just using "released" to match the regular release
        env.events()
            .publish((symbol_short(&env, "released"), escrow_id), payout);

        Ok(())
    }

    /// Calculate dynamic fee based on current locked liquidity.
    /// Fee(L) = BaseFee × (1 + γ × (L / Ltarget)^α)
    fn calculate_dynamic_fee(env: &Env, amount: i128) -> u32 {
        // Get dynamic fee config or use defaults
        let fee_config: DynamicFeeConfig = env
            .storage()
            .instance()
            .get(&DataKey::DynamicFeeConfig)
            .unwrap_or(DynamicFeeConfig {
                base_fee_bps: DEFAULT_DYNAMIC_FEE_BASE_BPS,
                gamma_fp: DEFAULT_DYNAMIC_FEE_GAMMA_FP,
                alpha: DEFAULT_DYNAMIC_FEE_ALPHA,
                target_liquidity: DEFAULT_DYNAMIC_FEE_TARGET_LIQUIDITY,
            });

        let current_liquidity: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LockedLiquidity)
            .unwrap_or(0);

        // Calculate L / Ltarget (fixed-point: 10000 = 1.0)
        let safe_liquidity = current_liquidity.max(0) as u128;
        let liquidity_ratio_fp = if fee_config.target_liquidity > 0 {
            ((safe_liquidity * 10_000) / (fee_config.target_liquidity as u128)) as u32
        } else {
            10_000 // Default to 1.0 if target is zero
        };

        // Calculate (L / Ltarget)^α (simplified for α=2: just square it)
        let power_term = if fee_config.alpha == 2 {
            ((liquidity_ratio_fp as u128 * liquidity_ratio_fp as u128) / 10_000) as u32
        } else if fee_config.alpha == 1 {
            liquidity_ratio_fp
        } else {
            // For other exponents, use simplified iteration or cap
            liquidity_ratio_fp // Fallback: linear
        };

        // Fee = base_fee × (1 + γ × power_term / 10000)
        let multiplier_fp =
            10_000 + ((fee_config.gamma_fp as u128 * power_term as u128) / 10_000) as u32;
        ((fee_config.base_fee_bps as u128 * multiplier_fp as u128) / 10_000) as u32
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
        Self::flatten_branch_cost(&env);
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

        // Issue #334: reject locks whose USD-equivalent value exceeds the admin cap.
        enforce_max_usd_limit(&env, &token_addr, amount);

        let timeout_ledger = env.ledger().sequence() + timeout_ledgers;

        // Create a single-tranche trade for backward compatibility
        let mut tranches = Vec::new(&env);
        tranches.push_back(Tranche {
            amount,
            secret_hash: secret_hash.clone(),
            released: false,
        });

        let state = TradeState {
            seller,
            buyer: buyer.clone(),
            amount,
            secret_hash,
            tranches,
            timeout_ledger,
            status: TradeStatus::Locked,
        };

        // CEI (issue #273): write trade (+ optional bond) bookkeeping before pulls.
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 100_000);

        let params = bond_params(&env);
        let need_bond =
            params.bond_amount > 0 && read_reputation(&env, &buyer) < params.establish_threshold;
        if need_bond {
            env.storage()
                .instance()
                .set(&DataKey::Bond(id.clone()), &params.bond_amount);
        }

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
            .extend_ttl(&DataKey::TradeCounter, TTL_EXTEND, TTL_EXTEND);
        env.storage()
            .persistent()
            .set(&DataKey::TradeId(next_idx), &id);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::TradeId(next_idx), TTL_EXTEND, TTL_EXTEND);

        let client = token::Client::new(&env, &token_addr);
        client.transfer(&buyer, &env.current_contract_address(), &amount);

        // Issue #280: an "unestablished" buyer posts a refundable bond.
        if need_bond {
            client.transfer(&buyer, &env.current_contract_address(), &params.bond_amount);
        }

        env.events()
            .publish((symbol_short(&env, "locked"), id), amount);
    }

    fn release(env: Env, id: BytesN<32>, secret: BytesN<32>) {
        // Issue #266: intentionally does NOT call check_not_paused.
        // Pause only closes the front door (new `lock`s). `release` and
        // `refund` are the back door for already-locked funds — blocking them
        // while paused would trap user money in the contract, which is worse
        // than having no pause mechanism at all.
        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = match env.storage().persistent().get(&key) {
            Some(s) => s,
            None => return,
        };

        if state.status != TradeStatus::Locked {
            return;
        }

        // For backward compatibility: if trade has a single tranche, release it
        // Otherwise, verify against the legacy secret_hash field (first tranche)
        if state.tranches.len() == 1 {
            let tranche = state.tranches.get(0).unwrap();
            if tranche.released {
                return;
            }

            let computed = env.crypto().sha256(&secret.into());
            if computed.to_bytes() != tranche.secret_hash {
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

            Self::complete_with_bond_refund(&env, &id, &state.buyer, state.amount);

            let client = token::Client::new(&env, &token_addr);
            client.transfer(&env.current_contract_address(), &state.seller, &payout);
            if fee > 0 {
                client.transfer(&env.current_contract_address(), &admin, &fee);
            }

            env.events()
                .publish((symbol_short(&env, "released"), id), payout);
        } else {
            // For multi-tranche trades, users should use release_tranche()
            // But we check the first tranche's secret for compatibility
            let computed = env.crypto().sha256(&secret.into());
            if computed.to_bytes() != state.secret_hash {
                panic_with_error(&env, Error::InvalidSecret);
            }
            // If secret matches, return specific error directing user to release_tranche instead
            panic_with_error(&env, Error::MultiTrancheUseReleaseTranche);
        }
    }

    fn refund(env: Env, id: BytesN<32>) -> i128 {
        // Issue #266: intentionally does NOT call check_not_paused — same
        // reasoning as `release`: already-locked funds must never be trapped
        // by the circuit breaker.
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

        // Calculate the unreleased amount (sum of all unreleased tranches)
        let mut refund_amount: i128 = 0;
        for i in 0..state.tranches.len() {
            let tranche = state.tranches.get(i).unwrap();
            if !tranche.released {
                refund_amount += tranche.amount;
            }
        }

        // CEI pattern: update state before external calls
        state.status = TradeStatus::Refunded;
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);

        // Only transfer if there's an unreleased amount to refund
        if refund_amount > 0 {
            let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
            let client = token::Client::new(&env, &token_addr);
            client.transfer(
                &env.current_contract_address(),
                &state.buyer,
                &refund_amount,
            );
        }

        env.events()
            .publish((symbol_short(&env, "refunded"), id), refund_amount);

        refund_amount
    }
}

#[contractimpl]
impl EscrowContract {
    /// Lock funds with multiple tranches, each with its own secret hash.
    /// Each tranche can be released independently by revealing its secret.
    /// The sum of tranche amounts MUST equal the total amount parameter.
    pub fn lock_with_tranches(
        env: Env,
        id: BytesN<32>,
        seller: Address,
        buyer: Address,
        amount: i128,
        tranches: Vec<Tranche>,
        timeout_ledgers: u32,
    ) -> Result<(), Error> {
        check_not_paused(&env);
        Self::flatten_branch_cost(&env);
        buyer.require_auth();

        if amount <= 0 || amount > (i128::MAX / 10_000) {
            return Err(Error::InvalidAmount);
        }
        if timeout_ledgers == 0 || timeout_ledgers > DEFAULT_TIMEOUT_LEDGERS_MAX {
            return Err(Error::InvalidTimeout);
        }
        if tranches.is_empty() {
            return Err(Error::NoTranches);
        }

        // Critical: validate that tranche amounts sum exactly to the total
        let mut tranche_sum: i128 = 0;
        for tranche in tranches.iter() {
            if tranche.amount <= 0 {
                return Err(Error::InvalidAmount);
            }
            tranche_sum = tranche_sum
                .checked_add(tranche.amount)
                .ok_or(Error::InvalidAmount)?;
        }
        if tranche_sum != amount {
            return Err(Error::TrancheSumMismatch);
        }

        let key = DataKey::Trade(id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::TradeAlreadyExists);
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)?;

        let timeout_ledger = env.ledger().sequence() + timeout_ledgers;

        // Use first tranche's secret_hash for backward compatibility with single-secret queries
        let first_secret_hash = tranches.get(0).unwrap().secret_hash.clone();

        let state = TradeState {
            seller,
            buyer: buyer.clone(),
            amount,
            secret_hash: first_secret_hash,
            tranches,
            timeout_ledger,
            status: TradeStatus::Locked,
        };

        // CEI (issue #273): write trade (+ optional bond) bookkeeping before pulls.
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 100_000);

        let params = bond_params(&env);
        let need_bond =
            params.bond_amount > 0 && read_reputation(&env, &buyer) < params.establish_threshold;
        if need_bond {
            env.storage()
                .instance()
                .set(&DataKey::Bond(id.clone()), &params.bond_amount);
        }

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

        let client = token::Client::new(&env, &token_addr);
        client.transfer(&buyer, &env.current_contract_address(), &amount);

        // Issue #280: an "unestablished" buyer posts a refundable bond.
        if need_bond {
            client.transfer(&buyer, &env.current_contract_address(), &params.bond_amount);
        }

        env.events()
            .publish((symbol_short(&env, "locked"), id), amount);
        Ok(())
    }

    /// Release a specific tranche by index, revealing its secret.
    /// Returns the amount released (after fee).
    pub fn release_tranche(
        env: Env,
        id: BytesN<32>,
        tranche_index: u32,
        secret: BytesN<32>,
    ) -> Result<i128, Error> {
        // Issue #266: intentionally does NOT call check_not_paused.
        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if state.status != TradeStatus::Locked {
            return Err(Error::TradeNotLocked);
        }

        if tranche_index >= state.tranches.len() {
            return Err(Error::InvalidTrancheIndex);
        }

        let mut tranche = state.tranches.get(tranche_index).unwrap();
        if tranche.released {
            return Err(Error::TrancheAlreadyReleased);
        }

        // Verify the secret matches this tranche's hash
        let computed = env.crypto().sha256(&secret.into());
        if computed.to_bytes() != tranche.secret_hash {
            return Err(Error::InvalidSecret);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(0);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();

        let fee = (tranche.amount * fee_bps as i128) / 10_000;
        let payout = tranche.amount - fee;

        // Mark this tranche as released
        tranche.released = true;
        state.tranches.set(tranche_index, tranche);

        // Check if all tranches are now released
        let mut all_released = true;
        for i in 0..state.tranches.len() {
            if !state.tranches.get(i).unwrap().released {
                all_released = false;
                break;
            }
        }

        // Complete with bond refund on successful tranche release (proves trade is legitimate, not spam)
        Self::complete_with_bond_refund(&env, &id, &state.buyer, state.amount);

        // If all tranches are released, mark the entire trade as Released
        if all_released {
            state.status = TradeStatus::Released;
        }

        // CEI pattern: update state before external calls
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);

        let client = token::Client::new(&env, &token_addr);
        client.transfer(&env.current_contract_address(), &state.seller, &payout);
        if fee > 0 {
            client.transfer(&env.current_contract_address(), &admin, &fee);
        }

        env.events().publish(
            (symbol_short(&env, "tranche_rel"), id.clone()),
            (tranche_index, payout),
        );

        if all_released {
            env.events()
                .publish((symbol_short(&env, "released"), id), state.amount);
        }

        Ok(payout)
    }
}

/// Derives the id for a trade created via `chain_release_to_lock()`:
/// sha256(release_trade_id || new_secret_hash). Deterministic rather than
/// caller-supplied so the function's signature needs no extra id argument;
/// collisions are not a practical concern (sha256 preimage) and the
/// `TradeAlreadyExists` check still guards against one regardless.
fn chained_trade_id(
    env: &Env,
    release_trade_id: &BytesN<32>,
    new_secret_hash: &BytesN<32>,
) -> BytesN<32> {
    let mut msg: Bytes = release_trade_id.clone().into();
    msg.append(&new_secret_hash.clone().into());
    env.crypto().sha256(&msg).to_bytes()
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

fn is_effectively_paused(env: &Env) -> bool {
    let armed: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if !armed {
        return false;
    }
    let effective: u32 = env
        .storage()
        .instance()
        .get(&DataKey::PauseEffectiveLedger)
        .unwrap_or(0);
    env.ledger().sequence() >= effective
}

fn check_not_paused(env: &Env) {
    if is_effectively_paused(env) {
        panic_with_error(env, Error::ContractPaused);
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

/// Enforce `amount * price / 10^decimals <= max_usd_limit` when a positive
/// limit is configured (issue #334). A zero/unset limit is a no-op so existing
/// deployments and tests keep working until an admin opts in.
fn enforce_max_usd_limit(env: &Env, token: &Address, amount: i128) {
    let max_usd: i128 = env
        .storage()
        .instance()
        .get(&DataKey::MaxUsdLimit)
        .unwrap_or(0);
    if max_usd == 0 {
        return;
    }

    let oracle_addr: Address = env
        .storage()
        .instance()
        .get(&DataKey::OracleAddress)
        .unwrap_or_else(|| panic_with_error(env, Error::OracleNotConfigured));

    let oracle = PriceOracleClient::new(env, &oracle_addr);
    let asset = OracleAsset::Stellar(token.clone());
    let quote = match oracle.lastprice(&asset) {
        Some(data) if data.price > 0 => data,
        _ => panic_with_error(env, Error::PriceUnavailable),
    };

    let decimals = oracle.decimals();
    if decimals > 38 {
        panic_with_error(env, Error::PriceUnavailable);
    }
    let scale = 10i128.pow(decimals);

    // amount * price / scale <= max_usd  <=>  amount * price <= max_usd * scale
    let lhs = amount
        .checked_mul(quote.price)
        .unwrap_or_else(|| panic_with_error(env, Error::InvalidAmount));
    let rhs = max_usd
        .checked_mul(scale)
        .unwrap_or_else(|| panic_with_error(env, Error::InvalidAmount));
    if lhs > rhs {
        panic_with_error(env, Error::ExceedsMaxUsdLimit);
    }
}

fn symbol_short(env: &Env, s: &str) -> soroban_sdk::Symbol {
    soroban_sdk::Symbol::new(env, s)
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
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

    fn test_arb_set(env: &Env) -> ArbitratorSet {
        ArbitratorSet {
            keys: Vec::new(env),
            // Zero thresholds so unit tests that resolve disputes without
            // ed25519 arbitrator signatures still exercise the happy path.
            threshold_epoch1: 0,
            threshold_epoch2: 0,
            t1_ledgers: 100,
            t2_ledgers: 200,
        }
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
        client.initialize(&admin, &token_addr, &fee_bps, &test_arb_set(&env));
        let no_sigs: Vec<Address> = Vec::new(&env);
        client.set_arbitrator(&arbitrator, &no_sigs);

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

    /// Front-running / griefing resistance test for release().
    ///
    /// Simulates two near-simultaneous release() calls for the same trade
    /// with the same valid secret — the second call must fail cleanly and
    /// cheaply with TradeNotLocked, with no unexpected side effects.
    ///
    /// This formally verifies the analysis in issue #272: front-running a
    /// release() with the same secret is unprofitable (attacker pays gas to
    /// execute the victim's intent; payout destination is immutable) and the
    /// victim's transaction fails early at the status check with minimal cost.
    #[test]
    fn test_release_front_running_resistance_same_secret() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        // First release succeeds (simulates the front-runner's transaction
        // confirming first, or the legitimate transaction confirming first).
        f.client.release(&f.id, &f.secret);

        // Verify the payout went to the correct (immutable) seller.
        assert_eq!(f.token.balance(&f.seller), 495);
        assert_eq!(f.token.balance(&f.admin), 5);
        assert_eq!(f.token.balance(&f.contract_id), 0);

        // Second release with the SAME valid secret — simulates the other
        // transaction attempting to execute after the first has confirmed.
        // Must be a no-op return.
        let result = f.client.try_release(&f.id, &f.secret);
        assert!(result.is_ok(), "second release is no-op");

        // Balances must be unchanged — no double-payout, no fee duplication.
        assert_eq!(f.token.balance(&f.seller), 495);
        assert_eq!(f.token.balance(&f.admin), 5);
        assert_eq!(f.token.balance(&f.contract_id), 0);

        // Trade status must remain Released.
        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Released);
    }

    /// Griefing test: front-running with an INVALID secret.
    ///
    /// Attacker sees valid release in mempool, submits invalid secret first.
    /// Must fail at secret verification (InvalidSecret), then legitimate
    /// transaction succeeds normally.
    #[test]
    fn test_release_griefing_resistance_invalid_secret() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        // Attacker front-runs with an invalid secret.
        let wrong_secret = BytesN::from_array(&f.env, &[9u8; 32]);
        let result = f.client.try_release(&f.id, &wrong_secret);
        assert!(result.is_err());

        // Legitimate release with correct secret must still succeed.
        f.client.release(&f.id, &f.secret);

        assert_eq!(f.token.balance(&f.seller), 495);
        assert_eq!(f.token.balance(&f.admin), 5);
        assert_eq!(f.token.balance(&f.contract_id), 0);

        let trade = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade.status, TradeStatus::Released);
    }

    /// Front-running resistance for batch_release(): each item is independent.
    ///
    /// A front-runner submitting a batch containing one valid and one invalid
    /// item for the same trade should not be able to block or corrupt the
    /// valid item's payout.
    #[test]
    fn test_batch_release_front_running_independence() {
        let f = setup(2_000, 100);
        let seller2 = Address::generate(&f.env);
        let secret2 = BytesN::from_array(&f.env, &[8u8; 32]);
        let secret_hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
        let id2 = BytesN::from_array(&f.env, &[2u8; 32]);

        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
        f.client
            .lock(&id2, &seller2, &f.buyer, &300, &secret_hash2, &100);

        // Batch with one valid secret (for id) and one invalid secret (for id2).
        let wrong_secret = BytesN::from_array(&f.env, &[9u8; 32]);
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

        // Only the valid item should be released.
        assert_eq!(released.len(), 1);
        assert_eq!(released.get(0).unwrap(), f.id.clone());

        assert_eq!(f.token.balance(&f.seller), 495);
        assert_eq!(f.token.balance(&seller2), 0); // invalid secret skipped
        assert_eq!(f.token.balance(&f.admin), 5); // only one fee collected

        // The invalid item's trade must remain Locked (untouched).
        assert_eq!(
            f.client.get_trade(&id2).unwrap().status,
            TradeStatus::Locked
        );
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

        f.client.resolve_dispute(&f.id, &5_000, &Vec::new(&f.env));

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
        f.client.resolve_dispute(&f.id, &10_000, &Vec::new(&f.env));

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
        f.client.resolve_dispute(&f.id, &0, &Vec::new(&f.env));

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
        f.client.resolve_dispute(&f.id, &5_000, &Vec::new(&f.env));

        assert!(f
            .client
            .try_resolve_dispute(&f.id, &5_000, &Vec::new(&f.env))
            .is_err());
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
        client.initialize(&admin, &token_addr, &100, &test_arb_set(&env));
        let no_sigs: Vec<Address> = Vec::new(&env);
        client.set_arbitrator(&arbitrator, &no_sigs);

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
            .try_resolve_dispute(&id, &5_000, &Vec::new(&env));

        assert!(result.is_err());
        assert_eq!(client.get_trade(&id).unwrap().status, TradeStatus::Disputed);
    }

    #[test]
    fn test_resolve_dispute_rejects_split_over_100_percent() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
        f.client.raise_dispute(&f.buyer, &f.id);

        assert!(f
            .client
            .try_resolve_dispute(&f.id, &10_001, &Vec::new(&f.env))
            .is_err());
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
        assert!(f
            .client
            .try_resolve_dispute(&f.id, &5_000, &Vec::new(&f.env))
            .is_err());
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
        EscrowContractClient::new(&env, &env.register_contract(None, EscrowContract)).initialize(
            &admin,
            &token,
            &10_001,
            &test_arb_set(&env),
        );
    }

    #[test]
    #[should_panic(expected = "8")]
    fn test_lock_overflow_amount_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let client = EscrowContractClient::new(&env, &env.register_contract(None, EscrowContract));

        client.initialize(&admin, &token, &100, &test_arb_set(&env));

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
        m.f.client
            .resolve_dispute(&m.f.id, &10_000, &Vec::new(&m.f.env));
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
    // Escrow-to-escrow atomic trade chaining (issue #271).
    //
    // chain_release_to_lock() releases trade A's logic and re-locks the
    // same payout directly into a new trade B, so a cash provider can
    // re-circulate incoming funds without them ever landing in a wallet.
    // ------------------------------------------------------------------

    fn new_secret_and_hash(env: &Env, byte: u8) -> (BytesN<32>, BytesN<32>) {
        let secret = BytesN::from_array(env, &[byte; 32]);
        let hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
        (secret, hash)
    }

    #[test]
    fn chain_release_to_lock_relocks_the_payout_without_an_external_transfer() {
        let f = setup(1_000, 100); // 1% fee
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        let new_seller = Address::generate(&f.env);
        let (new_secret, new_secret_hash) = new_secret_and_hash(&f.env, 42);

        let new_id =
            f.client
                .chain_release_to_lock(&f.id, &f.secret, &new_seller, &new_secret_hash, &50);

        // Trade A is released...
        let trade_a = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade_a.status, TradeStatus::Released);

        // ...but its seller never received a wallet transfer: the payout
        // went straight into trade B instead.
        assert_eq!(f.token.balance(&f.seller), 0);

        // Trade B exists, Locked, funded for the same payout (amount minus
        // fee), with f.seller as its buyer and new_seller as its seller.
        let trade_b = f.client.get_trade(&new_id).unwrap();
        assert_eq!(trade_b.status, TradeStatus::Locked);
        assert_eq!(trade_b.seller, new_seller);
        assert_eq!(trade_b.buyer, f.seller);
        assert_eq!(trade_b.amount, 495); // 500 - 1%
        assert_eq!(trade_b.secret_hash, new_secret_hash);

        // Only the platform fee ever left the contract; the rest of trade
        // A's escrowed amount is still inside the contract, now backing
        // trade B.
        assert_eq!(f.token.balance(&f.admin), 5);
        assert_eq!(f.token.balance(&f.contract_id), 495);

        // Sanity: trade B's own secret unlocks it exactly like any trade.
        f.client.release(&new_id, &new_secret);
        assert_eq!(f.token.balance(&new_seller), 491); // 495 - 1% (fee truncates down)
    }

    #[test]
    fn chain_release_to_lock_requires_release_trade_sellers_authorization() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        let new_seller = Address::generate(&f.env);
        let (_new_secret, new_secret_hash) = new_secret_and_hash(&f.env, 42);
        let outsider = Address::generate(&f.env);

        let invoke = MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "chain_release_to_lock",
            args: (
                f.id.clone(),
                f.secret.clone(),
                new_seller.clone(),
                new_secret_hash.clone(),
                50u32,
            )
                .into_val(&f.env),
            sub_invokes: &[],
        };

        // An outsider — someone who merely knows the secret but is not
        // trade A's seller — cannot authorize the chain.
        let result = f
            .client
            .mock_auths(&[MockAuth {
                address: &outsider,
                invoke: &invoke,
            }])
            .try_chain_release_to_lock(&f.id, &f.secret, &new_seller, &new_secret_hash, &50);
        assert!(result.is_err());

        // Trade A is untouched — the rejected attempt didn't partially
        // apply.
        let trade_a = f.client.get_trade(&f.id).unwrap();
        assert_eq!(trade_a.status, TradeStatus::Locked);

        // The legitimate recipient (trade A's seller) can authorize it.
        let new_id = f
            .client
            .mock_auths(&[MockAuth {
                address: &f.seller,
                invoke: &invoke,
            }])
            .chain_release_to_lock(&f.id, &f.secret, &new_seller, &new_secret_hash, &50);

        let trade_b = f.client.get_trade(&new_id).unwrap();
        assert_eq!(trade_b.status, TradeStatus::Locked);
    }

    #[test]
    fn chain_release_to_lock_rejects_wrong_secret() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        let new_seller = Address::generate(&f.env);
        let (_new_secret, new_secret_hash) = new_secret_and_hash(&f.env, 42);
        let wrong_secret = BytesN::from_array(&f.env, &[0u8; 32]);

        assert!(f
            .client
            .try_chain_release_to_lock(&f.id, &wrong_secret, &new_seller, &new_secret_hash, &50)
            .is_err());
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
        f.client.resolve_dispute(&f.id, &10_000, &Vec::new(&f.env));
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
            .try_resolve_dispute(&pool.f.id, &10_000, &Vec::new(&pool.f.env))
            .is_err());
    }

    #[test]
    fn chain_release_to_lock_cannot_be_replayed_against_an_already_released_trade() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        let new_seller = Address::generate(&f.env);
        let (_new_secret, new_secret_hash) = new_secret_and_hash(&f.env, 42);
        f.client
            .chain_release_to_lock(&f.id, &f.secret, &new_seller, &new_secret_hash, &50);

        // Trying to chain the same, now-Released trade again must fail —
        // it is no longer Locked.
        let (_again_secret, again_hash) = new_secret_and_hash(&f.env, 43);
        assert!(f
            .client
            .try_chain_release_to_lock(&f.id, &f.secret, &new_seller, &again_hash, &50)
            .is_err());
    }

    #[test]
    fn chained_trade_can_be_refunded_after_its_own_timeout_like_any_trade() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        let new_seller = Address::generate(&f.env);
        let (_new_secret, new_secret_hash) = new_secret_and_hash(&f.env, 42);
        let new_id =
            f.client
                .chain_release_to_lock(&f.id, &f.secret, &new_seller, &new_secret_hash, &50);

        f.env.ledger().with_mut(|li| li.sequence_number += 51);
        f.client.refund(&new_id);

        // f.seller is trade B's buyer, so a timed-out trade B refunds back
        // to f.seller exactly as an ordinary trade would.
        assert_eq!(f.token.balance(&f.seller), 495);
        let trade_b = f.client.get_trade(&new_id).unwrap();
        assert_eq!(trade_b.status, TradeStatus::Refunded);
    }

    #[test]
    fn chained_trade_can_be_disputed_and_resolved_like_any_trade() {
        let f = setup(1_000, 100);
        f.client
            .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

        let new_seller = Address::generate(&f.env);
        let (_new_secret, new_secret_hash) = new_secret_and_hash(&f.env, 42);
        let new_id =
            f.client
                .chain_release_to_lock(&f.id, &f.secret, &new_seller, &new_secret_hash, &50);

        // f.seller is trade B's buyer, and can dispute it exactly like any
        // other trade's buyer.
        f.client.dispute(&f.seller, &new_id);
        let trade_b = f.client.get_trade(&new_id).unwrap();
        assert_eq!(trade_b.status, TradeStatus::Disputed);

        f.client
            .resolve_dispute(&new_id, &10_000, &Vec::new(&f.env));
        assert_eq!(f.token.balance(&f.seller), 495);
        let trade_b = f.client.get_trade(&new_id).unwrap();
        assert_eq!(trade_b.status, TradeStatus::Resolved);
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

        pool.f
            .client
            .resolve_dispute(&pool.f.id, &10_000, &Vec::new(&pool.f.env));
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
        // Front-running / griefing resistance for release() (issue #272).
        //
        // These tests formally verify that the contract's logic is immune to
        // front-running and griefing attacks when the secret is revealed in
        // the mempool. The threat model: an attacker observes a pending
        // release(id, secret) transaction and attempts to front-run it.
        //
        // The contract is safe because:
        //   1. Payout destination (seller) is immutable — fixed at lock().
        //   2. CEI pattern: state updated to Released BEFORE external calls.
        //   3. Secret verification happens BEFORE state change.
        //   4. Any second attempt (front-run or retry) fails fast at the
        //      status check with TradeNotLocked — cheap revert, no side effects.
        // ------------------------------------------------------------------

        /// Front-runner submits the SAME valid secret for the same trade.
        /// Attacker's tx confirms first, pays out to the legitimate seller.
        /// Legitimate tx then fails fast with TradeNotLocked (cheap revert).
        /// Attacker gains nothing, spends gas to do seller's work.
        #[test]
        fn release_front_run_same_valid_secret_attacker_pays_seller_legit_fails_fast() {
            let f = setup(1_000, 100);
            f.client
                .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

            // Attacker front-runs with the same valid secret
            f.client.release(&f.id, &f.secret);

            // Seller gets paid (attacker's tx executed the payout)
            assert_eq!(f.token.balance(&f.seller), 495); // 500 - 1% fee
            assert_eq!(f.token.balance(&f.admin), 5);
            assert_eq!(f.token.balance(&f.contract_id), 0);

            // Trade state is Released
            assert_eq!(
                f.client.get_trade(&f.id).unwrap().status,
                TradeStatus::Released
            );

            // Legitimate caller's subsequent attempt fails fast with TradeNotLocked
            // (simulated by calling release again — in reality this would be a
            // separate transaction that reverts at the status check)
            let result = f.client.try_release(&f.id, &f.secret);
            assert!(result.is_err(), "second release must fail");
            // The error is TradeNotLocked (10) — status check fails before any
            // crypto or token operations, so revert is cheap.
        }

        /// Griefing attempt: front-runner submits an INVALID secret for the
        /// same trade. Attacker's tx fails at secret verification (InvalidSecret)
        /// BEFORE any state change. Legitimate tx then succeeds normally.
        /// Attacker wastes gas; legitimate party unaffected.
        #[test]
        fn release_front_run_invalid_secret_griefing_fails_fast_legit_succeeds() {
            let f = setup(1_000, 100);
            f.client
                .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

            let invalid_secret = BytesN::from_array(&f.env, &[99u8; 32]);

            // Attacker's griefing attempt fails at secret verification
            let grief_result = f.client.try_release(&f.id, &invalid_secret);
            assert!(grief_result.is_err(), "invalid secret must fail");

            // Trade state UNCHANGED — still Locked, funds still escrowed
            assert_eq!(
                f.client.get_trade(&f.id).unwrap().status,
                TradeStatus::Locked
            );
            assert_eq!(f.token.balance(&f.contract_id), 500);
            assert_eq!(f.token.balance(&f.seller), 0);

            // Legitimate release now succeeds normally
            f.client.release(&f.id, &f.secret);

            assert_eq!(f.token.balance(&f.seller), 495);
            assert_eq!(f.token.balance(&f.admin), 5);
            assert_eq!(
                f.client.get_trade(&f.id).unwrap().status,
                TradeStatus::Released
            );
        }

        /// Batch release front-running resistance: attacker includes a valid
        /// secret for a target trade in a batch, hoping to front-run the
        /// legitimate single release. The batch item succeeds, pays the
        /// legitimate seller. Legitimate single release then fails fast.
        /// No value extraction possible.
        #[test]
        fn batch_release_front_run_valid_secret_pays_seller_legit_fails_fast() {
            let f = setup(2_000, 100);
            let seller2 = Address::generate(&f.env);
            let secret2 = BytesN::from_array(&f.env, &[8u8; 32]);
            let secret_hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
            let id2 = BytesN::from_array(&f.env, &[2u8; 32]);

            f.client
                .lock(&id2, &seller2, &f.buyer, &300, &secret_hash2, &100);

            // Attacker front-runs by including target trade in a batch
            let releases = vec![
                &f.env,
                BatchReleaseItem {
                    id: f.id.clone(),
                    secret: f.secret.clone(),
                },
            ];
            let released = f.client.batch_release(&releases);

            assert_eq!(released.len(), 1);
            assert_eq!(released.get(0).unwrap(), f.id.clone());

            // Seller paid by attacker's batch tx
            assert_eq!(f.token.balance(&f.seller), 495);
            assert_eq!(
                f.client.get_trade(&f.id).unwrap().status,
                TradeStatus::Released
            );

            // Legitimate single release fails fast
            let result = f.client.try_release(&f.id, &f.secret);
            assert!(result.is_err());
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
        }

        /// Secret revelation in mempool does not compromise other trades.
        /// Each trade has independent secret_hash; knowing one secret gives
        /// zero advantage for any other trade.
        #[test]
        fn release_secret_revelation_does_not_compromise_other_trades() {
            let f = setup(2_000, 100);
            let seller2 = Address::generate(&f.env);
            let secret2 = BytesN::from_array(&f.env, &[8u8; 32]);
            let secret_hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
            let id2 = BytesN::from_array(&f.env, &[2u8; 32]);

            f.client
                .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
            f.client
                .lock(&id2, &seller2, &f.buyer, &300, &secret_hash2, &100);

            // Attacker learns secret for trade 1 (from mempool observation)
            // but cannot use it for trade 2
            let bad_attempt = f.client.try_release(&id2, &f.secret); // wrong secret for id2
            assert!(bad_attempt.is_err());

            // Trade 2 still locked, funds safe
            assert_eq!(
                f.client.get_trade(&id2).unwrap().status,
                TradeStatus::Locked
            );
            assert_eq!(f.token.balance(&seller2), 0);
            assert_eq!(f.token.balance(&f.contract_id), 700);

            // Legitimate release of trade 2 still works with its own secret
            f.client.release(&id2, &secret2);
            assert_eq!(f.token.balance(&seller2), 297); // 300 - 1%
            assert_eq!(
                f.client.get_trade(&id2).unwrap().status,
                TradeStatus::Released
            );
            assert_eq!(f.token.balance(&f.contract_id), 0);
        }

        // ------------------------------------------------------------------
        // Atomic release_batch() — all succeed or all fail.
        // ------------------------------------------------------------------

        #[test]
        fn release_batch_atomically_releases_3_valid_trades() {
            let f = setup(2_000, 100); // 1% fee
            let seller2 = Address::generate(&f.env);
            let seller3 = Address::generate(&f.env);

            let secret2 = BytesN::from_array(&f.env, &[8u8; 32]);
            let secret_hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
            let id2 = BytesN::from_array(&f.env, &[2u8; 32]);

            let secret3 = BytesN::from_array(&f.env, &[9u8; 32]);
            let secret_hash3 = f.env.crypto().sha256(&secret3.clone().into()).to_bytes();
            let id3 = BytesN::from_array(&f.env, &[3u8; 32]);

            // Lock 3 trades with different amounts.
            f.client
                .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
            f.client
                .lock(&id2, &seller2, &f.buyer, &300, &secret_hash2, &100);
            f.client
                .lock(&id3, &seller3, &f.buyer, &200, &secret_hash3, &100);

            let releases = vec![
                &f.env,
                BatchReleaseItem {
                    id: f.id.clone(),
                    secret: f.secret.clone(),
                },
                BatchReleaseItem {
                    id: id2.clone(),
                    secret: secret2.clone(),
                },
                BatchReleaseItem {
                    id: id3.clone(),
                    secret: secret3.clone(),
                },
            ];

            // Call atomic release_batch — must succeed.
            f.client.release_batch(&releases);

            // All 3 trades are Released.
            assert_eq!(
                f.client.get_trade(&f.id).unwrap().status,
                TradeStatus::Released
            );
            assert_eq!(
                f.client.get_trade(&id2).unwrap().status,
                TradeStatus::Released
            );
            assert_eq!(
                f.client.get_trade(&id3).unwrap().status,
                TradeStatus::Released
            );

            // Verify exact payouts: 1% fee deducted from each seller.
            assert_eq!(f.token.balance(&f.seller), 495); // 500 - 5
            assert_eq!(f.token.balance(&seller2), 297); // 300 - 3
            assert_eq!(f.token.balance(&seller3), 198); // 200 - 2

            // Admin collected exact fees: 5 + 3 + 2 = 10.
            assert_eq!(f.token.balance(&f.admin), 10);
        }

        #[test]
        fn release_batch_reverts_entire_batch_on_invalid_secret() {
            let f = setup(2_000, 100);
            let seller2 = Address::generate(&f.env);

            let secret2 = BytesN::from_array(&f.env, &[8u8; 32]);
            let secret_hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
            let id2 = BytesN::from_array(&f.env, &[2u8; 32]);

            let wrong_secret = BytesN::from_array(&f.env, &[99u8; 32]);

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
                    secret: wrong_secret, // Invalid secret for id2
                },
            ];

            // Atomic release_batch must fail and revert.
            assert!(f.client.try_release_batch(&releases).is_err());

            // Both trades remain Locked, untouched.
            assert_eq!(
                f.client.get_trade(&f.id).unwrap().status,
                TradeStatus::Locked
            );
            assert_eq!(
                f.client.get_trade(&id2).unwrap().status,
                TradeStatus::Locked
            );

            // No funds transferred.
            assert_eq!(f.token.balance(&f.seller), 0);
            assert_eq!(f.token.balance(&seller2), 0);
            assert_eq!(f.token.balance(&f.admin), 0);
        }

        #[test]
        fn release_batch_reverts_entire_batch_on_nonexistent_trade() {
            let f = setup(2_000, 100);
            let seller2 = Address::generate(&f.env);

            let secret2 = BytesN::from_array(&f.env, &[8u8; 32]);
            let secret_hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
            let id2 = BytesN::from_array(&f.env, &[2u8; 32]);

            let nonexistent_id = BytesN::from_array(&f.env, &[99u8; 32]);

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
                    id: nonexistent_id,
                    secret: f.secret.clone(),
                },
            ];

            // Atomic release_batch must fail (trade doesn't exist).
            assert!(f.client.try_release_batch(&releases).is_err());

            // Both existing trades remain Locked.
            assert_eq!(
                f.client.get_trade(&f.id).unwrap().status,
                TradeStatus::Locked
            );
            assert_eq!(
                f.client.get_trade(&id2).unwrap().status,
                TradeStatus::Locked
            );

            // No funds transferred.
            assert_eq!(f.token.balance(&f.seller), 0);
            assert_eq!(f.token.balance(&seller2), 0);
        }

        #[test]
        fn release_batch_reverts_on_trade_not_in_locked_state() {
            let f = setup(2_000, 100);
            let seller2 = Address::generate(&f.env);

            let secret2 = BytesN::from_array(&f.env, &[8u8; 32]);
            let secret_hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
            let id2 = BytesN::from_array(&f.env, &[2u8; 32]);

            f.client
                .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
            f.client
                .lock(&id2, &seller2, &f.buyer, &300, &secret_hash2, &100);

            // Release id2 first, moving it to Released state.
            f.client.release(&id2, &secret2);

            let releases = vec![
                &f.env,
                BatchReleaseItem {
                    id: f.id.clone(),
                    secret: f.secret.clone(),
                },
                BatchReleaseItem {
                    id: id2.clone(),
                    secret: secret2.clone(),
                },
            ];

            // Atomic release_batch must fail (id2 is Released, not Locked).
            assert!(f.client.try_release_batch(&releases).is_err());

            // id1 must remain Locked (the batch reverted before releasing it).
            assert_eq!(
                f.client.get_trade(&f.id).unwrap().status,
                TradeStatus::Locked
            );
            assert_eq!(
                f.client.get_trade(&id2).unwrap().status,
                TradeStatus::Released
            );

            // Seller1 got no payout (batch failed).
            assert_eq!(f.token.balance(&f.seller), 0);
            // Seller2 was already released.
            assert_eq!(f.token.balance(&seller2), 297);
        }

        #[test]
        fn release_batch_matches_fee_accounting_to_individual_releases() {
            let f = setup(1_000, 250); // 2.5% fee
            let seller2 = Address::generate(&f.env);

            let secret2 = BytesN::from_array(&f.env, &[8u8; 32]);
            let secret_hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
            let id2 = BytesN::from_array(&f.env, &[2u8; 32]);

            // Set up two trades with different amounts.
            f.client
                .lock(&f.id, &f.seller, &f.buyer, &1000, &f.secret_hash, &100);
            f.client
                .lock(&id2, &seller2, &f.buyer, &400, &secret_hash2, &100);

            // Release them atomically.
            let releases = vec![
                &f.env,
                BatchReleaseItem {
                    id: f.id.clone(),
                    secret: f.secret.clone(),
                },
                BatchReleaseItem {
                    id: id2.clone(),
                    secret: secret2.clone(),
                },
            ];
            f.client.release_batch(&releases);

            // Verify fees are calculated exactly as individual releases would:
            // Trade 1: 1000 * 250 / 10_000 = 25 fee, payout 975
            // Trade 2: 400 * 250 / 10_000 = 10 fee, payout 390
            // Total fee: 35
            assert_eq!(f.token.balance(&f.seller), 975);
            assert_eq!(f.token.balance(&seller2), 390);
            assert_eq!(f.token.balance(&f.admin), 35);
        }
    }
}

#[cfg(test)]
mod property_test;

#[cfg(test)]
mod malicious_token;

#[cfg(test)]
mod reentrancy_test;

#[cfg(test)]
mod oracle_usd_test;

/// Standalone unit tests (including issue #334 oracle USD limit coverage).
#[cfg(test)]
#[path = "test.rs"]
mod unit_tests;

#[cfg(test)]
mod tranche_tests;
