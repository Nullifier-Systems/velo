//! Malicious SEP-41-shaped token used only in escrow reentrancy tests (issue #273).
//!
//! Implements the subset of the token interface escrow actually calls
//! (`transfer` / `balance`) plus `mint` for test setup. On configured transfers
//! it attempts to call back into the escrow contract — exactly the attack the
//! audit asks us to try for real.

#![cfg(test)]

use crate::EscrowContractClient;
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub enum AttackKind {
    /// Reenter `release(id, secret)`.
    Release,
    /// Reenter `refund(id)`.
    Refund,
    /// Reenter `lock` with a fresh id (same buyer/seller/amount/hash).
    Lock,
    /// Reenter `resolve_dispute`.
    ResolveDispute,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Balance(Address),
    Escrow,
    AttackKind,
    TradeId,
    Secret,
    Seller,
    Buyer,
    Amount,
    SecretHash,
    TimeoutLedgers,
    AttackArmed,
    AttackAttempted,
}

#[contract]
pub struct MaliciousToken;

#[contractimpl]
impl MaliciousToken {
    /// Wire the escrow target and which callback to fire on the next matching transfer.
    pub fn configure_attack(
        env: Env,
        escrow: Address,
        kind: AttackKind,
        trade_id: BytesN<32>,
        secret: BytesN<32>,
        seller: Address,
        buyer: Address,
        amount: i128,
        secret_hash: BytesN<32>,
        timeout_ledgers: u32,
    ) {
        env.storage().instance().set(&DataKey::Escrow, &escrow);
        env.storage().instance().set(&DataKey::AttackKind, &kind);
        env.storage().instance().set(&DataKey::TradeId, &trade_id);
        env.storage().instance().set(&DataKey::Secret, &secret);
        env.storage().instance().set(&DataKey::Seller, &seller);
        env.storage().instance().set(&DataKey::Buyer, &buyer);
        env.storage().instance().set(&DataKey::Amount, &amount);
        env.storage().instance().set(&DataKey::SecretHash, &secret_hash);
        env.storage()
            .instance()
            .set(&DataKey::TimeoutLedgers, &timeout_ledgers);
        env.storage().instance().set(&DataKey::AttackArmed, &true);
        env.storage()
            .instance()
            .set(&DataKey::AttackAttempted, &false);
    }

    pub fn disarm(env: Env) {
        env.storage().instance().set(&DataKey::AttackArmed, &false);
    }

    pub fn attack_attempted(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::AttackAttempted)
            .unwrap_or(false)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let bal = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to), &(bal + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id))
            .unwrap_or(0)
    }

    /// SEP-41 `transfer`. Updates balances, then optionally attempts escrow reentry.
    ///
    /// Hard-invokes escrow so a host reentrancy rejection traps this `transfer`
    /// and rolls back the outer escrow call (atomicity — no partial payout).
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();

        let from_bal = Self::balance(env.clone(), from.clone());
        if from_bal < amount {
            panic!("insufficient balance");
        }
        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &(from_bal - amount));
        let to_bal = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &(to_bal + amount));

        let armed: bool = env
            .storage()
            .instance()
            .get(&DataKey::AttackArmed)
            .unwrap_or(false);
        if !armed {
            return;
        }

        // Only attack once per configuration so nested transfer (e.g. fee leg)
        // does not recurse forever inside the token itself.
        env.storage().instance().set(&DataKey::AttackArmed, &false);
        env.storage()
            .instance()
            .set(&DataKey::AttackAttempted, &true);

        let escrow: Address = env.storage().instance().get(&DataKey::Escrow).unwrap();
        let kind: AttackKind = env.storage().instance().get(&DataKey::AttackKind).unwrap();
        let trade_id: BytesN<32> = env.storage().instance().get(&DataKey::TradeId).unwrap();
        let escrow_client = EscrowContractClient::new(&env, &escrow);

        match kind {
            AttackKind::Release => {
                let secret: BytesN<32> = env.storage().instance().get(&DataKey::Secret).unwrap();
                escrow_client.release(&trade_id, &secret);
            }
            AttackKind::Refund => {
                escrow_client.refund(&trade_id);
            }
            AttackKind::Lock => {
                let seller: Address = env.storage().instance().get(&DataKey::Seller).unwrap();
                let buyer: Address = env.storage().instance().get(&DataKey::Buyer).unwrap();
                let amt: i128 = env.storage().instance().get(&DataKey::Amount).unwrap();
                let secret_hash: BytesN<32> =
                    env.storage().instance().get(&DataKey::SecretHash).unwrap();
                let timeout: u32 = env
                    .storage()
                    .instance()
                    .get(&DataKey::TimeoutLedgers)
                    .unwrap();
                let mut bytes = [9u8; 32];
                bytes[0] = 0xaa;
                let other_id = BytesN::from_array(&env, &bytes);
                escrow_client.lock(&other_id, &seller, &buyer, &amt, &secret_hash, &timeout);
            }
            AttackKind::ResolveDispute => {
                let empty: Vec<(u32, BytesN<64>)> = Vec::new(&env);
                let _ = escrow_client.resolve_dispute(&trade_id, &5_000u32, &empty);
            }
        }
    }
}
