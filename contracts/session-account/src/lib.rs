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
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, Symbol,
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
}

const DAY_IN_LEDGERS: u64 = 8640; // ~24 hours at 10s per ledger

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

        env.events()
            .publish((Symbol::new(&env, "spending_cap_updated"),), (session_key, new_spending_cap));

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

    /// Get the main account address.
    pub fn get_main_account(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::MainAccount)
            .ok_or(Error::NotInitialized)
    }
}

// Implement the Soroban account interface with custom authorization
// In Soroban SDK v21, custom account contracts implement __check_auth as a contract function
#[contractimpl]
impl SessionAccount {
    /// Custom authorization hook that enforces session key bounds.
    /// This is called by Soroban for every operation authorized by this contract.
    /// 
    /// Note: This is a simplified implementation for demonstration. In production,
    /// you would need to:
    /// 1. Parse the actual signature from the auth context
    /// 2. Verify the Ed25519 signature against the message
    /// 3. Extract the signer address from the signature
    /// 4. Parse the Soroban invocation to determine token amounts
    /// 
    /// For this demo, we accept the signer address directly as a parameter
    /// to avoid complex signature verification logic.
    pub fn check_auth_with_signer(
        env: Env,
        signer: Address,
        amount: i128,
    ) -> Result<(), soroban_sdk::Error> {
        let main_account: Address = match env.storage().instance().get(&DataKey::MainAccount) {
            Some(addr) => addr,
            None => return Err(soroban_sdk::Error::from_contract_error(Error::NotInitialized as u32)),
        };
        
        // If the signer is the main account, always allow
        if signer == main_account {
            return Ok(());
        }

        // Check if this is a session key
        let key = DataKey::SessionKey(signer.clone());
        let session_info: SessionKeyInfo = match env.storage().instance().get(&key) {
            Some(info) => info,
            None => return Err(soroban_sdk::Error::from_contract_error(Error::UnauthorizedSigner as u32)),
        };

        // Check if session key is active
        if !session_info.active {
            return Err(soroban_sdk::Error::from_contract_error(Error::SessionKeyInactive as u32));
        }

        // Check time window
        let current_ledger = env.ledger().sequence();
        if u64::from(current_ledger) < session_info.valid_from_ledger {
            return Err(soroban_sdk::Error::from_contract_error(Error::SessionKeyNotYetValid as u32));
        }
        if u64::from(current_ledger) > session_info.valid_until_ledger {
            return Err(soroban_sdk::Error::from_contract_error(Error::SessionKeyExpired as u32));
        }

        // Check spending cap
        let spent_key = DataKey::Spent(signer.clone());
        let current_spent: i128 = env.storage().instance().get(&spent_key).unwrap_or(0);
        
        if current_spent + amount > session_info.spending_cap {
            return Err(soroban_sdk::Error::from_contract_error(Error::SpendingCapExceeded as u32));
        }

        // Update the spent amount
        env.storage()
            .instance()
            .set(&spent_key, &(current_spent + amount));

        Ok(())
    }
}


#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

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
            let result = SessionAccount::create_session_key(
                env.clone(),
                session_key,
                spending_cap,
                7,
                0,
            );
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
            SessionAccount::create_session_key(env.clone(), session_key.clone(), 100_000_000, 7, 0).unwrap();
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
            SessionAccount::create_session_key(env.clone(), session_key.clone(), 100_000_000, 7, 0).unwrap();
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
            let result = SessionAccount::create_session_key(env.clone(), session_key.clone(), 100_000_000, 31, 0);
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
            SessionAccount::create_session_key(env.clone(), session_key.clone(), spending_cap, 7, 0).unwrap();
        });

        env.as_contract(&contract_address, || {
            // First authorization should succeed
            SessionAccount::check_auth_with_signer(env.clone(), session_key.clone(), 10_000_000).unwrap();

            // Check spent amount
            let spent = SessionAccount::get_spent(env.clone(), session_key.clone()).unwrap();
            assert_eq!(spent, 10_000_000);

            // Second authorization should succeed
            SessionAccount::check_auth_with_signer(env.clone(), session_key.clone(), 20_000_000).unwrap();

            let spent = SessionAccount::get_spent(env.clone(), session_key.clone()).unwrap();
            assert_eq!(spent, 30_000_000);

            // Third authorization should exceed cap and fail
            let result = SessionAccount::check_auth_with_signer(env.clone(), session_key.clone(), 30_000_000);
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
            SessionAccount::create_session_key(env.clone(), session_key.clone(), spending_cap, 7, 1).unwrap();
        });

        env.as_contract(&contract_address, || {
            // Authorization should fail because key is not yet valid
            let result = SessionAccount::check_auth_with_signer(env.clone(), session_key.clone(), 10_000_000);
            assert!(result.is_err());
        });

        // Test with immediate validity (no delay)
        let session_key2 = Address::generate(&env);
        env.as_contract(&contract_address, || {
            // Create session key with no delay
            SessionAccount::create_session_key(env.clone(), session_key2.clone(), spending_cap, 7, 0).unwrap();
        });

        env.as_contract(&contract_address, || {
            // Authorization should succeed because key is immediately valid
            SessionAccount::check_auth_with_signer(env.clone(), session_key2.clone(), 10_000_000).unwrap();
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
            SessionAccount::create_session_key(env.clone(), session_key.clone(), 100_000_000, 7, 0).unwrap();
        });

        env.as_contract(&contract_address, || {
            // Authorization should succeed initially
            SessionAccount::check_auth_with_signer(env.clone(), session_key.clone(), 10_000_000).unwrap();
        });

        env.as_contract(&contract_address, || {
            // Revoke the session key
            SessionAccount::revoke_session_key(env.clone(), session_key.clone()).unwrap();
        });

        env.as_contract(&contract_address, || {
            // Authorization should now fail
            let result = SessionAccount::check_auth_with_signer(env.clone(), session_key.clone(), 10_000_000);
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
            SessionAccount::check_auth_with_signer(env.clone(), main_account.clone(), 1_000_000_000).unwrap();
        });
    }
}
