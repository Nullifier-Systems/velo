//! Session Account: A Soroban custom account contract with session key support.
//!
//! This contract allows users to create session keys with bounded spending limits
//! and time windows, enabling better UX by avoiding per-transaction signatures while
//! maintaining on-chain security guarantees.
//!
//! Key features:
//! - Session keys with spending caps (maximum total spend)
//! - Time windows (start/end ledger bounds)
//! - Instant revocation by the main account
//! - Fallback to main account signature for any operation
//! - On-chain enforcement of all bounds via __check_auth
//! - Emergency circuit-breaker pause grants (#374): the main account can grant
//!   this account the authority to authorize `pause`/`unpause` on a specific
//!   escrow contract, letting the API's automated arbitration engine halt a
//!   compromised escrow within its SLA without holding a per-escrow admin key.
//! - Emergency 2-of-3 multi-sig key rotation (#375): three rotation admins can
//!   swap out a compromised session key without the main account key. The old
//!   key is permanently revoked and the new key inherits the remaining quota
//!   and the original validity window.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    Address, Env, Symbol, TryIntoVal, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// The main account that owns this session account
    MainAccount,
    /// Session key data: SessionKey(Address) -> SessionKeyInfo
    SessionKey(Address),
    /// Total spent by a session key: Spent(Address) -> i128
    Spent(Address),
    /// Emergency circuit-breaker pause grant (#374):
    /// PauseGrant(escrow_contract) -> expiry ledger
    PauseGrant(Address),
    /// The 2-of-3 emergency rotation admin set (#375)
    RotationAdmins,
    /// Rotation proposal data: RotationProposal(id) -> RotationProposal
    RotationProposal(u64),
    /// Identifier handed to the next rotation proposal
    NextProposalId,
    /// Session key revoked by a rotation: Revoked(Address) -> bool
    Revoked(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionKeyInfo {
    /// The session key address
    pub key: Address,
    /// Maximum amount this session key can spend (in stroops)
    pub spending_cap: i128,
    /// Starting ledger number when this key becomes valid
    pub valid_from_ledger: u64,
    /// Ending ledger number when this key expires
    pub valid_until_ledger: u64,
    /// Whether this session key is currently active
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RotationProposal {
    /// The compromised session key to revoke
    pub old_key: Address,
    /// The replacement session key to create on execution
    pub new_key: Address,
    /// Rotation admins that have approved so far, proposer first
    pub approvals: Vec<Address>,
    /// Whether the rotation has already been carried out
    pub executed: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    /// Contract is already initialized
    AlreadyInitialized = 1,
    /// Contract is not initialized
    NotInitialized = 2,
    /// Only the main account can perform this operation
    NotMainAccount = 3,
    /// Session key already exists
    SessionKeyExists = 4,
    /// Session key not found
    SessionKeyNotFound = 5,
    /// Invalid spending cap (must be positive)
    InvalidSpendingCap = 6,
    /// Invalid time window (end before start)
    InvalidTimeWindow = 7,
    /// Session key is not active
    SessionKeyInactive = 8,
    /// Session key is expired
    SessionKeyExpired = 9,
    /// Session key is not yet valid
    SessionKeyNotYetValid = 10,
    /// Spending cap exceeded
    SpendingCapExceeded = 11,
    /// Unauthorized signer
    UnauthorizedSigner = 12,
    /// No emergency pause grant covers this escrow contract
    PauseGrantNotFound = 13,
    /// Emergency pause grant has expired
    PauseGrantExpired = 14,
    /// The rotation admin set has not been configured
    RotationAdminsNotSet = 15,
    /// Signer is not part of the rotation admin set
    NotRotationAdmin = 16,
    /// Rotation proposal not found
    ProposalNotFound = 17,
    /// This admin has already approved the proposal
    AlreadyApproved = 18,
    /// Rotation proposal has already been executed
    ProposalAlreadyExecuted = 19,
    /// Session key was revoked by an emergency rotation
    SessionKeyRevoked = 20,
    /// The rotation admin set must hold exactly 3 addresses
    InvalidAdminCount = 21,
}

const DAY_IN_LEDGERS: u64 = 8640; // ~24 hours at 10s per ledger

/// Number of admins in the rotation set, and approvals needed to execute.
const ROTATION_ADMIN_COUNT: u32 = 3;
const ROTATION_THRESHOLD: u32 = 2;

#[contract]
pub struct SessionAccount;

#[contractimpl]
impl SessionAccount {
    /// Initialize the session account with the main account address.
    /// This can only be called once.
    pub fn initialize(env: Env, main_account: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::MainAccount) {
            return Err(Error::AlreadyInitialized);
        }

        // Verify the caller is the main account
        main_account.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::MainAccount, &main_account);

        env.events()
            .publish((Symbol::new(&env, "initialized"),), main_account);

        Ok(())
    }

    /// Create a new session key with spending cap and time window.
    /// Only callable by the main account.
    ///
    /// # Arguments
    /// * `session_key` - The address of the session key
    /// * `spending_cap` - Maximum amount this key can spend (in stroops)
    /// * `duration_days` - Duration in days for which this key is valid
    /// * `start_delay_days` - Days before this key becomes valid (0 for immediate)
    pub fn create_session_key(
        env: Env,
        session_key: Address,
        spending_cap: i128,
        duration_days: u64,
        start_delay_days: u64,
    ) -> Result<(), Error> {
        let main_account: Address = env
            .storage()
            .instance()
            .get(&DataKey::MainAccount)
            .ok_or(Error::NotInitialized)?;

        // Only main account can create session keys
        main_account.require_auth();

        if spending_cap <= 0 {
            return Err(Error::InvalidSpendingCap);
        }

        let current_ledger = env.ledger().sequence();
        let valid_from = u64::from(current_ledger) + (start_delay_days * DAY_IN_LEDGERS);
        let valid_until = valid_from + (duration_days * DAY_IN_LEDGERS);

        if valid_until <= valid_from {
            return Err(Error::InvalidTimeWindow);
        }

        if duration_days > 30 {
            return Err(Error::InvalidTimeWindow); // Max 30 days
        }

        let key = DataKey::SessionKey(session_key.clone());
        if env.storage().instance().has(&key) {
            return Err(Error::SessionKeyExists);
        }

        let session_info = SessionKeyInfo {
            key: session_key.clone(),
            spending_cap,
            valid_from_ledger: valid_from,
            valid_until_ledger: valid_until,
            active: true,
        };

        env.storage().instance().set(&key, &session_info);
        env.storage()
            .instance()
            .set(&DataKey::Spent(session_key.clone()), &0i128);

        env.events().publish(
            (Symbol::new(&env, "session_key_created"),),
            (session_key, spending_cap, valid_from, valid_until),
        );

        Ok(())
    }

    /// Revoke a session key immediately.
    /// Only callable by the main account.
    pub fn revoke_session_key(env: Env, session_key: Address) -> Result<(), Error> {
        let main_account: Address = env
            .storage()
            .instance()
            .get(&DataKey::MainAccount)
            .ok_or(Error::NotInitialized)?;

        main_account.require_auth();

        let key = DataKey::SessionKey(session_key.clone());
        let mut session_info: SessionKeyInfo = env
            .storage()
            .instance()
            .get(&key)
            .ok_or(Error::SessionKeyNotFound)?;

        session_info.active = false;
        env.storage().instance().set(&key, &session_info);

        env.events()
            .publish((Symbol::new(&env, "session_key_revoked"),), session_key);

        Ok(())
    }

    /// Update the spending cap of an existing session key.
    /// Only callable by the main account.
    pub fn update_spending_cap(
        env: Env,
        session_key: Address,
        new_spending_cap: i128,
    ) -> Result<(), Error> {
        let main_account: Address = env
            .storage()
            .instance()
            .get(&DataKey::MainAccount)
            .ok_or(Error::NotInitialized)?;

        main_account.require_auth();

        if new_spending_cap <= 0 {
            return Err(Error::InvalidSpendingCap);
        }

        let key = DataKey::SessionKey(session_key.clone());
        let mut session_info: SessionKeyInfo = env
            .storage()
            .instance()
            .get(&key)
            .ok_or(Error::SessionKeyNotFound)?;

        session_info.spending_cap = new_spending_cap;
        env.storage().instance().set(&key, &session_info);

        env.events().publish(
            (Symbol::new(&env, "spending_cap_updated"),),
            (session_key, new_spending_cap),
        );

        Ok(())
    }

    /// Get information about a session key.
    pub fn get_session_key(env: Env, session_key: Address) -> Result<SessionKeyInfo, Error> {
        let key = DataKey::SessionKey(session_key);
        env.storage()
            .instance()
            .get(&key)
            .ok_or(Error::SessionKeyNotFound)
    }

    /// Get the amount spent by a session key.
    pub fn get_spent(env: Env, session_key: Address) -> Result<i128, Error> {
        let key = DataKey::Spent(session_key);
        env.storage()
            .instance()
            .get(&key)
            .ok_or(Error::SessionKeyNotFound)
    }

    /// Get the remaining quota for a session key.
    pub fn get_remaining_quota(env: Env, session_key: Address) -> Result<i128, Error> {
        let info = Self::get_session_key(env.clone(), session_key.clone())?;
        let spent = Self::get_spent(env, session_key)?;
        Ok(info.spending_cap.saturating_sub(spent))
    }

    /// Get the main account address.
    pub fn get_main_account(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::MainAccount)
            .ok_or(Error::NotInitialized)
    }

    /// Grant this session account the authority to authorize emergency
    /// `pause`/`unpause` on a specific escrow contract (#374).
    ///
    /// Only the main account can grant. The grant expires after
    /// `duration_ledgers`, so a stolen or rotated session key cannot pause
    /// escrows indefinitely. The API's automated circuit breaker calls this
    /// once per escrow deployment (via a main-account signed transaction);
    /// every subsequent `pause(env, [])` on that escrow is then authorized
    /// by this account's `__check_auth` within the grant window.
    pub fn grant_emergency_pause(
        env: Env,
        escrow_contract: Address,
        duration_ledgers: u32,
    ) -> Result<(), Error> {
        let main_account: Address = env
            .storage()
            .instance()
            .get(&DataKey::MainAccount)
            .ok_or(Error::NotInitialized)?;

        main_account.require_auth();

        if duration_ledgers == 0 {
            return Err(Error::InvalidTimeWindow);
        }

        let expiry = env.ledger().sequence().saturating_add(duration_ledgers);
        env.storage()
            .instance()
            .set(&DataKey::PauseGrant(escrow_contract.clone()), &expiry);

        env.events().publish(
            (Symbol::new(&env, "emergency_pause_granted"),),
            (escrow_contract, expiry),
        );

        Ok(())
    }

    /// Revoke a pending emergency pause grant early.
    pub fn revoke_emergency_pause(env: Env, escrow_contract: Address) -> Result<(), Error> {
        let main_account: Address = env
            .storage()
            .instance()
            .get(&DataKey::MainAccount)
            .ok_or(Error::NotInitialized)?;

        main_account.require_auth();

        let key = DataKey::PauseGrant(escrow_contract.clone());
        if !env.storage().instance().has(&key) {
            return Err(Error::PauseGrantNotFound);
        }
        env.storage().instance().remove(&key);

        env.events().publish(
            (Symbol::new(&env, "emergency_pause_revoked"),),
            escrow_contract,
        );

        Ok(())
    }

    /// Remaining ledger count for the emergency pause grant on `escrow_contract`.
    pub fn get_emergency_pause_grant(env: Env, escrow_contract: Address) -> Result<u32, Error> {
        let expiry: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PauseGrant(escrow_contract))
            .ok_or(Error::PauseGrantNotFound)?;
        Ok(expiry)
    }

    /// Configure the 2-of-3 emergency rotation admin set (#375).
    ///
    /// Only the main account can set it, and it must hold exactly 3 addresses.
    /// Calling it again replaces the whole set, which is how an admin key is
    /// itself rotated out.
    pub fn set_rotation_admins(env: Env, admins: Vec<Address>) -> Result<(), Error> {
        let main_account: Address = env
            .storage()
            .instance()
            .get(&DataKey::MainAccount)
            .ok_or(Error::NotInitialized)?;

        main_account.require_auth();

        if admins.len() != ROTATION_ADMIN_COUNT {
            return Err(Error::InvalidAdminCount);
        }

        env.storage()
            .instance()
            .set(&DataKey::RotationAdmins, &admins);

        Ok(())
    }

    /// Propose swapping a compromised session key for a fresh one.
    ///
    /// The proposer must be a rotation admin and counts as the first approval,
    /// so one further admin is enough to execute the rotation.
    pub fn propose_rotation(
        env: Env,
        proposer: Address,
        old_key: Address,
        new_key: Address,
    ) -> Result<u64, Error> {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::RotationAdmins)
            .ok_or(Error::RotationAdminsNotSet)?;

        proposer.require_auth();

        if !admins.iter().any(|admin| admin == proposer) {
            return Err(Error::NotRotationAdmin);
        }

        if !env
            .storage()
            .instance()
            .has(&DataKey::SessionKey(old_key.clone()))
        {
            return Err(Error::SessionKeyNotFound);
        }
        if Self::is_revoked(&env, &old_key) {
            return Err(Error::SessionKeyRevoked);
        }
        if env
            .storage()
            .instance()
            .has(&DataKey::SessionKey(new_key.clone()))
        {
            return Err(Error::SessionKeyExists);
        }

        let proposal_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextProposalId)
            .unwrap_or(0);

        let proposal = RotationProposal {
            old_key,
            new_key,
            approvals: soroban_sdk::vec![&env, proposer],
            executed: false,
        };

        env.storage()
            .instance()
            .set(&DataKey::RotationProposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::NextProposalId, &(proposal_id + 1));

        Ok(proposal_id)
    }

    /// Approve a rotation proposal. The second distinct admin approval executes
    /// it: the old key is revoked and the new key is created with the quota the
    /// old key had left and the same validity window.
    pub fn approve_rotation(env: Env, approver: Address, proposal_id: u64) -> Result<(), Error> {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::RotationAdmins)
            .ok_or(Error::RotationAdminsNotSet)?;

        approver.require_auth();

        if !admins.iter().any(|admin| admin == approver) {
            return Err(Error::NotRotationAdmin);
        }

        let proposal_key = DataKey::RotationProposal(proposal_id);
        let mut proposal: RotationProposal = env
            .storage()
            .instance()
            .get(&proposal_key)
            .ok_or(Error::ProposalNotFound)?;

        if proposal.executed {
            return Err(Error::ProposalAlreadyExecuted);
        }
        if proposal.approvals.iter().any(|a| a == approver) {
            return Err(Error::AlreadyApproved);
        }

        proposal.approvals.push_back(approver);

        if proposal.approvals.len() >= ROTATION_THRESHOLD {
            Self::execute_rotation(&env, &mut proposal, proposal_id)?;
        }

        env.storage().instance().set(&proposal_key, &proposal);

        Ok(())
    }

    /// Get the rotation admin set.
    pub fn get_rotation_admins(env: Env) -> Result<Vec<Address>, Error> {
        env.storage()
            .instance()
            .get(&DataKey::RotationAdmins)
            .ok_or(Error::RotationAdminsNotSet)
    }

    /// Get a rotation proposal by id.
    pub fn get_rotation_proposal(env: Env, proposal_id: u64) -> Result<RotationProposal, Error> {
        env.storage()
            .instance()
            .get(&DataKey::RotationProposal(proposal_id))
            .ok_or(Error::ProposalNotFound)
    }
}

impl SessionAccount {
    /// Whether a session key was revoked by an emergency rotation.
    fn is_revoked(env: &Env, session_key: &Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Revoked(session_key.clone()))
            .unwrap_or(false)
    }

    /// Carry out an approved rotation. Revokes the old key and creates the new
    /// one with the leftover quota and the old validity window.
    fn execute_rotation(
        env: &Env,
        proposal: &mut RotationProposal,
        proposal_id: u64,
    ) -> Result<(), Error> {
        let old_storage_key = DataKey::SessionKey(proposal.old_key.clone());
        let mut old_info: SessionKeyInfo = env
            .storage()
            .instance()
            .get(&old_storage_key)
            .ok_or(Error::SessionKeyNotFound)?;

        if Self::is_revoked(env, &proposal.old_key) {
            return Err(Error::SessionKeyRevoked);
        }

        old_info.active = false;
        env.storage().instance().set(&old_storage_key, &old_info);
        env.storage()
            .instance()
            .set(&DataKey::Revoked(proposal.old_key.clone()), &true);

        // The replacement inherits what the old key had left, never zero or
        // negative, so an exhausted key still rotates to a usable one.
        let spent: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Spent(proposal.old_key.clone()))
            .unwrap_or(0);
        let remaining = old_info.spending_cap.saturating_sub(spent).max(1);

        let new_info = SessionKeyInfo {
            key: proposal.new_key.clone(),
            spending_cap: remaining,
            valid_from_ledger: old_info.valid_from_ledger,
            valid_until_ledger: old_info.valid_until_ledger,
            active: true,
        };
        env.storage()
            .instance()
            .set(&DataKey::SessionKey(proposal.new_key.clone()), &new_info);
        env.storage()
            .instance()
            .set(&DataKey::Spent(proposal.new_key.clone()), &0i128);

        proposal.executed = true;

        env.events().publish(
            (Symbol::new(env, "session_key_rotated"),),
            (
                proposal.old_key.clone(),
                proposal.new_key.clone(),
                proposal_id,
            ),
        );

        Ok(())
    }
}

/// Internal helper that enforces session-key bounds against an explicit
/// `(signer, amount)` pair — used internally by `__check_auth`.
/// Not exposed via `#[contractimpl]` as a callable contract entry point.
impl SessionAccount {
    pub fn check_auth_with_signer(env: Env, signer: Address, amount: i128) -> Result<(), Error> {
        Self::check_auth_with_signer_internal(&env, &signer, amount)
    }

    fn check_auth_with_signer_internal(
        env: &Env,
        signer: &Address,
        amount: i128,
    ) -> Result<(), Error> {
        let main_account: Address = match env.storage().instance().get(&DataKey::MainAccount) {
            Some(addr) => addr,
            None => return Err(Error::NotInitialized),
        };

        // If the signer is the main account, always allow
        if *signer == main_account {
            return Ok(());
        }

        // A key rotated out by the 2-of-3 multi-sig is dead for good (#375),
        // and that outranks the plain inactive flag.
        if Self::is_revoked(&env, &signer) {
            return Err(Error::SessionKeyRevoked);
        }

        // Check if this is a session key
        let key = DataKey::SessionKey(signer.clone());
        let session_info: SessionKeyInfo = match env.storage().instance().get(&key) {
            Some(info) => info,
            None => return Err(Error::UnauthorizedSigner),
        };

        // Check if session key is active
        if !session_info.active {
            return Err(Error::SessionKeyInactive);
        }

        // Check time window
        let current_ledger = env.ledger().sequence();
        if u64::from(current_ledger) < session_info.valid_from_ledger {
            return Err(Error::SessionKeyNotYetValid);
        }
        if u64::from(current_ledger) > session_info.valid_until_ledger {
            return Err(Error::SessionKeyExpired);
        }

        if amount <= 0 {
            return Ok(());
        }

        // Check spending cap
        let spent_key = DataKey::Spent(signer.clone());
        let current_spent: i128 = env.storage().instance().get(&spent_key).unwrap_or(0);

        let new_spent = match current_spent.checked_add(amount) {
            Some(val) => val,
            None => return Err(Error::SpendingCapExceeded),
        };

        if new_spent > session_info.spending_cap {
            return Err(Error::SpendingCapExceeded);
        }

        // Update the spent amount
        env.storage().instance().set(&spent_key, &new_spent);

        Ok(())
    }
}

// Implement the Soroban custom account interface.
//
// `__check_auth` is invoked by the host whenever an operation is authorized
// by this contract's address (e.g. token transfer or escrow pause). It:
//   1. Authorizes emergency `pause`/`unpause` on escrows covered by an
//      unexpired `PauseGrant` (#374).
//   2. Always authorizes the main account (attached as a delegated signer).
//   3. Otherwise requires an active, in-window session key to be attached as
//      a delegated signer, extracting transfer amount from auth_contexts.
//      A key rotated out by the 2-of-3 multi-sig (#375) is rejected before
//      the active flag is even read.
#[contractimpl]
impl CustomAccountInterface for SessionAccount {
    type Signature = ();
    type Error = Error;

    fn __check_auth(
        env: Env,
        _signature_payload: Hash<32>,
        _signatures: (),
        auth_contexts: Vec<Context>,
    ) -> Result<(), Error> {
        let main_account: Address = env
            .storage()
            .instance()
            .get(&DataKey::MainAccount)
            .ok_or(Error::NotInitialized)?;

        // (1) Emergency circuit-breaker pause grants (#374).
        for ctx in auth_contexts.iter() {
            let (contract, fn_name) = match ctx {
                Context::Contract(ContractContext {
                    contract, fn_name, ..
                }) => (contract, fn_name),
                _ => continue,
            };
            if fn_name == Symbol::new(&env, "pause") || fn_name == Symbol::new(&env, "unpause") {
                let expiry: u32 = env
                    .storage()
                    .instance()
                    .get(&DataKey::PauseGrant(contract.clone()))
                    .unwrap_or(0);
                if expiry == 0 {
                    return Err(Error::PauseGrantNotFound);
                }
                if u32::from(env.ledger().sequence()) > expiry {
                    return Err(Error::PauseGrantExpired);
                }
                return Ok(());
            }
        }

        // (2) Retrieve delegated signers attached to the auth context
        let delegated = env.custom_account().get_delegated_signers();
        if delegated.is_empty() {
            return Err(Error::UnauthorizedSigner);
        }

        // (3) The main account always authorizes.
        if delegated.iter().any(|d| d == main_account) {
            return Ok(());
        }

        // Extract transfer amount from auth_contexts if present
        let mut transfer_amount: Option<i128> = None;
        for ctx in auth_contexts.iter() {
            if let Context::Contract(ContractContext { fn_name, args, .. }) = ctx {
                if fn_name == Symbol::new(&env, "transfer") {
                    if args.len() >= 3 {
                        if let Ok(amt) = args.get(2).unwrap().try_into_val(&env) {
                            transfer_amount = Some(amt);
                            break;
                        }
                    }
                }
            }
        }

        // (4) Validate delegated session key signers
        for signer in delegated.iter() {
            let amount = transfer_amount.unwrap_or(0);
            Self::check_auth_with_signer_internal(&env, &signer, amount)?;
            return Ok(());
        }

        Err(Error::UnauthorizedSigner)
    }
}

#[cfg(test)]
mod test {
    extern crate std;
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        BytesN,
    };

    fn setup_env() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_address = Address::generate(&env);
        env.register_contract(&contract_address, SessionAccount);
        (env, contract_address)
    }

    #[test]
    fn test_initialize() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account.clone()).unwrap();
        });

        env.as_contract(&contract_address, || {
            let retrieved = SessionAccount::get_main_account(env.clone()).unwrap();
            assert_eq!(retrieved, main_account);
        });
    }

    #[test]
    fn test_initialize_twice_fails() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account.clone()).unwrap();
        });

        env.as_contract(&contract_address, || {
            let result = SessionAccount::initialize(env.clone(), main_account);
            assert_eq!(result, Err(Error::AlreadyInitialized));
        });
    }

    #[test]
    fn test_create_session_key() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account.clone()).unwrap();
        });

        let session_key = Address::generate(&env);
        let spending_cap = 100_000_000; // 10 USDC in stroops
        let duration_days = 7;
        let start_delay_days = 0;

        env.as_contract(&contract_address, || {
            SessionAccount::create_session_key(
                env.clone(),
                session_key.clone(),
                spending_cap,
                duration_days,
                start_delay_days,
            )
            .unwrap();
        });

        env.as_contract(&contract_address, || {
            let info = SessionAccount::get_session_key(env.clone(), session_key.clone()).unwrap();
            assert_eq!(info.spending_cap, spending_cap);
            assert_eq!(info.active, true);
        });
    }

    #[test]
    fn test_create_session_key_invalid_cap() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account).unwrap();
        });

        let session_key = Address::generate(&env);
        let spending_cap = 0; // Invalid

        env.as_contract(&contract_address, || {
            let result =
                SessionAccount::create_session_key(env.clone(), session_key, spending_cap, 7, 0);
            assert_eq!(result, Err(Error::InvalidSpendingCap));
        });
    }

    #[test]
    fn test_revoke_session_key() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account.clone()).unwrap();
        });

        let session_key = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::create_session_key(env.clone(), session_key.clone(), 100_000_000, 7, 0)
                .unwrap();
        });

        env.as_contract(&contract_address, || {
            SessionAccount::revoke_session_key(env.clone(), session_key.clone()).unwrap();
        });

        env.as_contract(&contract_address, || {
            let info = SessionAccount::get_session_key(env.clone(), session_key).unwrap();
            assert_eq!(info.active, false);
        });
    }

    #[test]
    fn test_update_spending_cap() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account).unwrap();
        });

        let session_key = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::create_session_key(env.clone(), session_key.clone(), 100_000_000, 7, 0)
                .unwrap();
        });

        let new_cap = 200_000_000;

        env.as_contract(&contract_address, || {
            SessionAccount::update_spending_cap(env.clone(), session_key.clone(), new_cap).unwrap();
        });

        env.as_contract(&contract_address, || {
            let info = SessionAccount::get_session_key(env.clone(), session_key).unwrap();
            assert_eq!(info.spending_cap, new_cap);
        });
    }

    #[test]
    fn test_time_window_validation() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account).unwrap();
        });

        let session_key = Address::generate(&env);

        env.as_contract(&contract_address, || {
            // Test duration > 30 days
            let result = SessionAccount::create_session_key(
                env.clone(),
                session_key.clone(),
                100_000_000,
                31,
                0,
            );
            assert_eq!(result, Err(Error::InvalidTimeWindow));
        });
    }

    #[test]
    fn test_spending_cap_enforcement() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account.clone()).unwrap();
        });

        let session_key = Address::generate(&env);
        let spending_cap = 50_000_000; // 5 USDC in stroops

        env.as_contract(&contract_address, || {
            SessionAccount::create_session_key(
                env.clone(),
                session_key.clone(),
                spending_cap,
                7,
                0,
            )
            .unwrap();
        });

        env.as_contract(&contract_address, || {
            // First authorization should succeed
            SessionAccount::check_auth_with_signer_internal(&env, &session_key, 10_000_000)
                .unwrap();

            // Check spent amount
            let spent = SessionAccount::get_spent(env.clone(), session_key.clone()).unwrap();
            assert_eq!(spent, 10_000_000);

            // Second authorization should succeed
            SessionAccount::check_auth_with_signer_internal(&env, &session_key, 20_000_000)
                .unwrap();

            let spent = SessionAccount::get_spent(env.clone(), session_key.clone()).unwrap();
            assert_eq!(spent, 30_000_000);

            // Third authorization should exceed cap and fail
            let result =
                SessionAccount::check_auth_with_signer_internal(&env, &session_key, 30_000_000);
            assert!(result.is_err());
        });
    }

    #[test]
    fn test_time_window_enforcement() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account).unwrap();
        });

        let session_key = Address::generate(&env);
        let spending_cap = 100_000_000;

        env.as_contract(&contract_address, || {
            // Create session key with 1 day delay
            SessionAccount::create_session_key(
                env.clone(),
                session_key.clone(),
                spending_cap,
                7,
                1,
            )
            .unwrap();
        });

        env.as_contract(&contract_address, || {
            // Authorization should fail because key is not yet valid
            let result =
                SessionAccount::check_auth_with_signer_internal(&env, &session_key, 10_000_000);
            assert!(result.is_err());
        });

        // Test with immediate validity (no delay)
        let session_key2 = Address::generate(&env);
        env.as_contract(&contract_address, || {
            // Create session key with no delay
            SessionAccount::create_session_key(
                env.clone(),
                session_key2.clone(),
                spending_cap,
                7,
                0,
            )
            .unwrap();
        });

        env.as_contract(&contract_address, || {
            // Authorization should succeed because key is immediately valid
            SessionAccount::check_auth_with_signer_internal(&env, &session_key2, 10_000_000)
                .unwrap();
        });
    }

    #[test]
    fn test_revocation_prevents_authorization() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account.clone()).unwrap();
        });

        let session_key = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::create_session_key(env.clone(), session_key.clone(), 100_000_000, 7, 0)
                .unwrap();
        });

        env.as_contract(&contract_address, || {
            // Authorization should succeed initially
            SessionAccount::check_auth_with_signer_internal(&env, &session_key, 10_000_000)
                .unwrap();
        });

        env.as_contract(&contract_address, || {
            // Revoke the session key
            SessionAccount::revoke_session_key(env.clone(), session_key.clone()).unwrap();
        });

        env.as_contract(&contract_address, || {
            // Authorization should now fail
            let result =
                SessionAccount::check_auth_with_signer_internal(&env, &session_key, 10_000_000);
            assert!(result.is_err());
        });
    }

    #[test]
    fn test_main_account_always_allowed() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account.clone()).unwrap();
        });

        env.as_contract(&contract_address, || {
            // Main account should always be able to authorize regardless of spending
            SessionAccount::check_auth_with_signer_internal(&env, &main_account, 1_000_000_000)
                .unwrap();
        });
    }

    #[test]
    fn test_token_transfer_via_session_key() {
        let env = Env::default();
        env.mock_all_auths();
        let main_account = Address::generate(&env);
        let session_account_addr = env.register(SessionAccount, ());
        let session_account_client = SessionAccountClient::new(&env, &session_account_addr);

        session_account_client.initialize(&main_account);

        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_client = soroban_sdk::token::Client::new(&env, &token_contract.address());
        let token_admin_client =
            soroban_sdk::token::StellarAssetClient::new(&env, &token_contract.address());

        // Mint 100 USDC (100_000_000 stroops) to session account
        token_admin_client.mint(&session_account_addr, &100_000_000);

        let session_key = Address::generate(&env);
        let recipient = Address::generate(&env);
        let cap = 50_000_000i128; // 50 USDC cap

        // Create session key
        session_account_client.create_session_key(&session_key, &cap, &7, &0);

        let account_sc: soroban_sdk::xdr::ScAddress =
            session_account_addr.clone().try_into().unwrap();
        let delegate_sc: soroban_sdk::xdr::ScAddress = session_key.clone().try_into().unwrap();
        let recipient_sc: soroban_sdk::xdr::ScAddress = recipient.clone().try_into().unwrap();
        let token_sc: soroban_sdk::xdr::ScAddress =
            token_contract.address().clone().try_into().unwrap();

        let amount_30 = 30_000_000i128;

        // 1. Authorize 30 USDC transfer using session key delegate
        env.set_auths(&[soroban_sdk::xdr::SorobanAuthorizationEntry {
            credentials: soroban_sdk::xdr::SorobanCredentials::AddressWithDelegates(
                soroban_sdk::xdr::SorobanAddressCredentialsWithDelegates {
                    address_credentials: soroban_sdk::xdr::SorobanAddressCredentials {
                        address: account_sc.clone(),
                        nonce: 1,
                        signature_expiration_ledger: 100,
                        signature: soroban_sdk::xdr::ScVal::Void,
                    },
                    delegates: std::vec![soroban_sdk::xdr::SorobanDelegateSignature {
                        address: delegate_sc.clone(),
                        signature: soroban_sdk::xdr::ScVal::Void,
                        nested_delegates: Default::default(),
                    }]
                    .try_into()
                    .unwrap(),
                },
            ),
            root_invocation: soroban_sdk::xdr::SorobanAuthorizedInvocation {
                function: soroban_sdk::xdr::SorobanAuthorizedFunction::ContractFn(
                    soroban_sdk::xdr::InvokeContractArgs {
                        contract_address: token_sc.clone(),
                        function_name: soroban_sdk::xdr::StringM::try_from("transfer")
                            .unwrap()
                            .into(),
                        args: std::vec![
                            soroban_sdk::xdr::ScVal::Address(account_sc.clone()),
                            soroban_sdk::xdr::ScVal::Address(recipient_sc.clone()),
                            soroban_sdk::xdr::ScVal::I128(soroban_sdk::xdr::Int128Parts {
                                hi: (amount_30 >> 64) as i64,
                                lo: amount_30 as u64,
                            }),
                        ]
                        .try_into()
                        .unwrap(),
                    },
                ),
                sub_invocations: Default::default(),
            },
        }]);

        token_client.transfer(&session_account_addr, &recipient, &amount_30);

        // Assert success and Spent == 30 USDC
        assert_eq!(session_account_client.get_spent(&session_key), 30_000_000);

        // 2. Attempt second 30 USDC transfer (cumulative 60 USDC > 50 USDC cap)
        env.set_auths(&[soroban_sdk::xdr::SorobanAuthorizationEntry {
            credentials: soroban_sdk::xdr::SorobanCredentials::AddressWithDelegates(
                soroban_sdk::xdr::SorobanAddressCredentialsWithDelegates {
                    address_credentials: soroban_sdk::xdr::SorobanAddressCredentials {
                        address: account_sc.clone(),
                        nonce: 2,
                        signature_expiration_ledger: 100,
                        signature: soroban_sdk::xdr::ScVal::Void,
                    },
                    delegates: std::vec![soroban_sdk::xdr::SorobanDelegateSignature {
                        address: delegate_sc.clone(),
                        signature: soroban_sdk::xdr::ScVal::Void,
                        nested_delegates: Default::default(),
                    }]
                    .try_into()
                    .unwrap(),
                },
            ),
            root_invocation: soroban_sdk::xdr::SorobanAuthorizedInvocation {
                function: soroban_sdk::xdr::SorobanAuthorizedFunction::ContractFn(
                    soroban_sdk::xdr::InvokeContractArgs {
                        contract_address: token_sc.clone(),
                        function_name: soroban_sdk::xdr::StringM::try_from("transfer")
                            .unwrap()
                            .into(),
                        args: std::vec![
                            soroban_sdk::xdr::ScVal::Address(account_sc.clone()),
                            soroban_sdk::xdr::ScVal::Address(recipient_sc.clone()),
                            soroban_sdk::xdr::ScVal::I128(soroban_sdk::xdr::Int128Parts {
                                hi: (amount_30 >> 64) as i64,
                                lo: amount_30 as u64,
                            }),
                        ]
                        .try_into()
                        .unwrap(),
                    },
                ),
                sub_invocations: Default::default(),
            },
        }]);

        let res = token_client.try_transfer(&session_account_addr, &recipient, &amount_30);
        assert!(res.is_err());
    }

    // --- Emergency circuit-breaker pause grants (#374) ---

    fn pause_contexts(env: &Env, escrow_contract: &Address) -> Vec<Context> {
        soroban_sdk::vec![
            env,
            Context::Contract(ContractContext {
                contract: escrow_contract.clone(),
                fn_name: Symbol::new(env, "pause"),
                args: soroban_sdk::Vec::new(env),
            })
        ]
    }

    #[test]
    fn test_emergency_pause_grant_lifecycle() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);
        let escrow_contract = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account.clone()).unwrap();
        });

        // Grant a 100-ledger emergency pause authorization on the escrow.
        env.as_contract(&contract_address, || {
            SessionAccount::grant_emergency_pause(env.clone(), escrow_contract.clone(), 100)
                .unwrap();
        });

        env.as_contract(&contract_address, || {
            let expiry =
                SessionAccount::get_emergency_pause_grant(env.clone(), escrow_contract.clone())
                    .unwrap();
            assert!(expiry > env.ledger().sequence());
        });

        // Revocation makes the grant unreadable.
        env.as_contract(&contract_address, || {
            SessionAccount::revoke_emergency_pause(env.clone(), escrow_contract.clone()).unwrap();
        });

        env.as_contract(&contract_address, || {
            assert_eq!(
                SessionAccount::get_emergency_pause_grant(env.clone(), escrow_contract.clone()),
                Err(Error::PauseGrantNotFound)
            );
        });
    }

    #[test]
    fn test_check_auth_authorizes_pause_with_grant() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);
        let escrow_contract = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account.clone()).unwrap();
        });

        env.as_contract(&contract_address, || {
            SessionAccount::grant_emergency_pause(env.clone(), escrow_contract.clone(), 100)
                .unwrap();
        });

        let hash: Hash<32> = env
            .crypto()
            .sha256(&BytesN::from_array(&env, &[0u8; 32]).into());
        let contexts = pause_contexts(&env, &escrow_contract);
        env.as_contract(&contract_address, || {
            SessionAccount::__check_auth(env.clone(), hash.clone(), (), contexts).unwrap();
        });
    }

    #[test]
    fn test_check_auth_rejects_pause_without_grant() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);
        let escrow_contract = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account.clone()).unwrap();
        });

        let hash: Hash<32> = env
            .crypto()
            .sha256(&BytesN::from_array(&env, &[0u8; 32]).into());
        let contexts = pause_contexts(&env, &escrow_contract);
        env.as_contract(&contract_address, || {
            let result = SessionAccount::__check_auth(env.clone(), hash.clone(), (), contexts);
            assert_eq!(result, Err(Error::PauseGrantNotFound));
        });
    }

    #[test]
    fn test_check_auth_rejects_expired_grant() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);
        let escrow_contract = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account.clone()).unwrap();
        });

        env.as_contract(&contract_address, || {
            SessionAccount::grant_emergency_pause(env.clone(), escrow_contract.clone(), 5).unwrap();
        });

        // Advance the ledger past the grant expiry.
        env.ledger().with_mut(|li| li.sequence_number += 10);

        let hash: Hash<32> = env
            .crypto()
            .sha256(&BytesN::from_array(&env, &[0u8; 32]).into());
        let contexts = pause_contexts(&env, &escrow_contract);
        env.as_contract(&contract_address, || {
            let result = SessionAccount::__check_auth(env.clone(), hash.clone(), (), contexts);
            assert_eq!(result, Err(Error::PauseGrantExpired));
        });
    }

    // --- Emergency 2-of-3 multi-sig key rotation (#375) ---

    /// Initialized account with a rotation admin set and one live session key.
    fn setup_rotation(
        env: &Env,
        contract_address: &Address,
        spending_cap: i128,
    ) -> (Vec<Address>, Address) {
        let main_account = Address::generate(env);
        let admins = soroban_sdk::vec![
            env,
            Address::generate(env),
            Address::generate(env),
            Address::generate(env)
        ];
        let session_key = Address::generate(env);

        env.as_contract(contract_address, || {
            SessionAccount::initialize(env.clone(), main_account).unwrap();
        });

        env.as_contract(contract_address, || {
            SessionAccount::set_rotation_admins(env.clone(), admins.clone()).unwrap();
        });

        env.as_contract(contract_address, || {
            SessionAccount::create_session_key(
                env.clone(),
                session_key.clone(),
                spending_cap,
                7,
                0,
            )
            .unwrap();
        });

        (admins, session_key)
    }

    #[test]
    fn test_set_rotation_admins() {
        let (env, contract_address) = setup_env();
        let (admins, _) = setup_rotation(&env, &contract_address, 100_000_000);

        env.as_contract(&contract_address, || {
            let stored = SessionAccount::get_rotation_admins(env.clone()).unwrap();
            assert_eq!(stored, admins);
        });
    }

    #[test]
    fn test_set_rotation_admins_wrong_count_fails() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account).unwrap();
        });

        let two = soroban_sdk::vec![&env, Address::generate(&env), Address::generate(&env)];
        let four = soroban_sdk::vec![
            &env,
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env)
        ];

        env.as_contract(&contract_address, || {
            assert_eq!(
                SessionAccount::set_rotation_admins(env.clone(), two),
                Err(Error::InvalidAdminCount)
            );
        });

        env.as_contract(&contract_address, || {
            assert_eq!(
                SessionAccount::set_rotation_admins(env.clone(), four),
                Err(Error::InvalidAdminCount)
            );
        });

        env.as_contract(&contract_address, || {
            assert_eq!(
                SessionAccount::get_rotation_admins(env.clone()),
                Err(Error::RotationAdminsNotSet)
            );
        });
    }

    #[test]
    fn test_rotation_two_of_three_executes() {
        let (env, contract_address) = setup_env();
        let (admins, old_key) = setup_rotation(&env, &contract_address, 100_000_000);
        let new_key = Address::generate(&env);

        let old_info = env.as_contract(&contract_address, || {
            SessionAccount::get_session_key(env.clone(), old_key.clone()).unwrap()
        });

        let proposal_id = env.as_contract(&contract_address, || {
            SessionAccount::propose_rotation(
                env.clone(),
                admins.get(0).unwrap(),
                old_key.clone(),
                new_key.clone(),
            )
            .unwrap()
        });
        assert_eq!(proposal_id, 0);

        env.as_contract(&contract_address, || {
            SessionAccount::approve_rotation(env.clone(), admins.get(1).unwrap(), proposal_id)
                .unwrap();
        });

        env.as_contract(&contract_address, || {
            let proposal = SessionAccount::get_rotation_proposal(env.clone(), proposal_id).unwrap();
            assert!(proposal.executed);
            assert_eq!(proposal.approvals.len(), 2);

            // The old key is inactive and permanently revoked.
            let old = SessionAccount::get_session_key(env.clone(), old_key.clone()).unwrap();
            assert!(!old.active);

            // The replacement carries the same window and is spendable.
            let new = SessionAccount::get_session_key(env.clone(), new_key.clone()).unwrap();
            assert!(new.active);
            assert_eq!(new.valid_from_ledger, old_info.valid_from_ledger);
            assert_eq!(new.valid_until_ledger, old_info.valid_until_ledger);
            assert_eq!(
                SessionAccount::get_spent(env.clone(), new_key.clone()).unwrap(),
                0
            );
            SessionAccount::check_auth_with_signer(env.clone(), new_key.clone(), 10_000_000)
                .unwrap();
        });
    }

    #[test]
    fn test_rotation_single_approval_does_not_execute() {
        let (env, contract_address) = setup_env();
        let (admins, old_key) = setup_rotation(&env, &contract_address, 100_000_000);
        let new_key = Address::generate(&env);

        let proposal_id = env.as_contract(&contract_address, || {
            SessionAccount::propose_rotation(
                env.clone(),
                admins.get(0).unwrap(),
                old_key.clone(),
                new_key.clone(),
            )
            .unwrap()
        });

        env.as_contract(&contract_address, || {
            let proposal = SessionAccount::get_rotation_proposal(env.clone(), proposal_id).unwrap();
            assert!(!proposal.executed);
            assert_eq!(proposal.approvals.len(), 1);
            assert_eq!(proposal.approvals.get(0).unwrap(), admins.get(0).unwrap());

            // Nothing changed on chain until the second admin signs.
            let old = SessionAccount::get_session_key(env.clone(), old_key.clone()).unwrap();
            assert!(old.active);
            assert_eq!(
                SessionAccount::get_session_key(env.clone(), new_key.clone()),
                Err(Error::SessionKeyNotFound)
            );
            SessionAccount::check_auth_with_signer(env.clone(), old_key.clone(), 10_000_000)
                .unwrap();
        });
    }

    #[test]
    fn test_propose_rotation_rejects_non_admin() {
        let (env, contract_address) = setup_env();
        let (_, old_key) = setup_rotation(&env, &contract_address, 100_000_000);
        let outsider = Address::generate(&env);
        let new_key = Address::generate(&env);

        env.as_contract(&contract_address, || {
            let result = SessionAccount::propose_rotation(env.clone(), outsider, old_key, new_key);
            assert_eq!(result, Err(Error::NotRotationAdmin));
        });
    }

    #[test]
    fn test_propose_rotation_requires_admin_set() {
        let (env, contract_address) = setup_env();
        let main_account = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::initialize(env.clone(), main_account).unwrap();
        });

        env.as_contract(&contract_address, || {
            let result = SessionAccount::propose_rotation(
                env.clone(),
                Address::generate(&env),
                Address::generate(&env),
                Address::generate(&env),
            );
            assert_eq!(result, Err(Error::RotationAdminsNotSet));
        });
    }

    #[test]
    fn test_approve_rotation_rejects_duplicate_approver() {
        let (env, contract_address) = setup_env();
        let (admins, old_key) = setup_rotation(&env, &contract_address, 100_000_000);
        let new_key = Address::generate(&env);

        let proposal_id = env.as_contract(&contract_address, || {
            SessionAccount::propose_rotation(
                env.clone(),
                admins.get(0).unwrap(),
                old_key.clone(),
                new_key,
            )
            .unwrap()
        });

        env.as_contract(&contract_address, || {
            // The proposer already counts as the first approval.
            let result =
                SessionAccount::approve_rotation(env.clone(), admins.get(0).unwrap(), proposal_id);
            assert_eq!(result, Err(Error::AlreadyApproved));

            let old = SessionAccount::get_session_key(env.clone(), old_key.clone()).unwrap();
            assert!(old.active);
        });
    }

    #[test]
    fn test_approve_rotation_rejects_executed_proposal() {
        let (env, contract_address) = setup_env();
        let (admins, old_key) = setup_rotation(&env, &contract_address, 100_000_000);
        let new_key = Address::generate(&env);

        let proposal_id = env.as_contract(&contract_address, || {
            SessionAccount::propose_rotation(env.clone(), admins.get(0).unwrap(), old_key, new_key)
                .unwrap()
        });

        env.as_contract(&contract_address, || {
            SessionAccount::approve_rotation(env.clone(), admins.get(1).unwrap(), proposal_id)
                .unwrap();
        });

        env.as_contract(&contract_address, || {
            let result =
                SessionAccount::approve_rotation(env.clone(), admins.get(2).unwrap(), proposal_id);
            assert_eq!(result, Err(Error::ProposalAlreadyExecuted));
        });
    }

    #[test]
    fn test_approve_rotation_unknown_proposal() {
        let (env, contract_address) = setup_env();
        let (admins, _) = setup_rotation(&env, &contract_address, 100_000_000);

        env.as_contract(&contract_address, || {
            let result = SessionAccount::approve_rotation(env.clone(), admins.get(0).unwrap(), 42);
            assert_eq!(result, Err(Error::ProposalNotFound));
        });
    }

    #[test]
    fn test_rotated_key_fails_auth_with_revoked_error() {
        let (env, contract_address) = setup_env();
        let (admins, old_key) = setup_rotation(&env, &contract_address, 100_000_000);
        let new_key = Address::generate(&env);

        let proposal_id = env.as_contract(&contract_address, || {
            SessionAccount::propose_rotation(
                env.clone(),
                admins.get(0).unwrap(),
                old_key.clone(),
                new_key,
            )
            .unwrap()
        });

        env.as_contract(&contract_address, || {
            SessionAccount::approve_rotation(env.clone(), admins.get(1).unwrap(), proposal_id)
                .unwrap();
        });

        env.as_contract(&contract_address, || {
            let result =
                SessionAccount::check_auth_with_signer(env.clone(), old_key.clone(), 10_000_000);
            assert_eq!(result, Err(Error::SessionKeyRevoked));
        });

        // A second proposal cannot resurrect the revoked key either.
        env.as_contract(&contract_address, || {
            let result = SessionAccount::propose_rotation(
                env.clone(),
                admins.get(0).unwrap(),
                old_key,
                Address::generate(&env),
            );
            assert_eq!(result, Err(Error::SessionKeyRevoked));
        });
    }

    #[test]
    fn test_rotated_key_inherits_remaining_quota() {
        let (env, contract_address) = setup_env();
        let (admins, old_key) = setup_rotation(&env, &contract_address, 50_000_000);
        let new_key = Address::generate(&env);

        env.as_contract(&contract_address, || {
            SessionAccount::check_auth_with_signer(env.clone(), old_key.clone(), 30_000_000)
                .unwrap();
        });

        let proposal_id = env.as_contract(&contract_address, || {
            SessionAccount::propose_rotation(
                env.clone(),
                admins.get(0).unwrap(),
                old_key,
                new_key.clone(),
            )
            .unwrap()
        });

        env.as_contract(&contract_address, || {
            SessionAccount::approve_rotation(env.clone(), admins.get(1).unwrap(), proposal_id)
                .unwrap();
        });

        env.as_contract(&contract_address, || {
            let new = SessionAccount::get_session_key(env.clone(), new_key.clone()).unwrap();
            assert_eq!(new.spending_cap, 20_000_000);

            // The leftover quota is spendable, one stroop more is not.
            SessionAccount::check_auth_with_signer(env.clone(), new_key.clone(), 20_000_000)
                .unwrap();
            assert!(
                SessionAccount::check_auth_with_signer(env.clone(), new_key.clone(), 1).is_err()
            );
        });
    }
}
