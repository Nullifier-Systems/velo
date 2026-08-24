//! Cross-asset yield aggregation vault (#408).
//!
//! Idle escrow collateral earns nothing while it waits for a cash hand-off.
//! This module closes that gap with two pieces:
//!
//! 1. [`YieldVaultContract`] — a standalone Soroban share-accounting vault
//!    (ERC-4626-style). Depositors receive shares minted pro-rata at the
//!    current exchange rate; harvested yield is added to `total_assets`
//!    WITHOUT minting shares, so the share price ratchets up. The
//!    contributor-note invariant — the exchange rate must NEVER decrease
//!    during harvesting (or any other operation) — is enforced arithmetically
//!    (every rounding step favours existing depositors) and re-checked
//!    defensively with an explicit `YieldError::RateWouldDecrease` guard.
//!
//! 2. Escrow-side rebalancing entry points live on `EscrowContract` itself
//!    (see the `set_yield_vault` / `deploy_idle_to_vault` /
//!    `recall_from_vault` / `deployed_to_vault` / `liquid_reserve` methods
//!    in lib.rs). The multisig points the escrow at a deployed vault with
//!    `set_yield_vault`, deploys idle reserves above the liquid buffer via
//!    `deploy_idle_to_vault`, and anyone can permissionlessly top the liquid
//!    buffer back up with `recall_from_vault` the instant trade-settlement
//!    demand eats into it — recall only moves escrow-owned funds back to the
//!    escrow, so it can never be used to attack a live trade.
//!
//! Off-chain, apps/api/src/lib/yield/buffer-optimizer.ts sizes the deploy /
//! recall legs and apps/api/src/lib/workers/yieldRebalanceWorker.ts drives
//! them periodically; these on-chain entry points stay deliberately dumb.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, Symbol,
};

/// Fixed-point scale for share exchange rates: rates are reported as
/// `assets * RATE_SCALE / shares`, leaving 12 decimal digits of precision
/// before truncation. Must match EXCHANGE_RATE_SCALE in @velo/shared
/// (packages/shared/src/types/yield.ts).
pub const RATE_SCALE: i128 = 1_000_000_000_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum YieldError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    /// Deposit / withdraw amount must be strictly positive.
    InvalidAmount = 3,
    /// Harvest amount must be strictly positive.
    InvalidYield = 4,
    /// Burning more shares than the provider holds.
    InsufficientShares = 5,
    /// Defensive guard: an operation attempted to lower the share exchange
    /// rate. Normal math cannot produce this (rounding always favours
    /// depositors), so hitting it means a bug — fail closed rather than
    /// silently diluting every depositor.
    RateWouldDecrease = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum VaultDataKey {
    Admin,
    Token,
    TotalShares,
    TotalAssets,
    Share(Address),
}

/// External yield strategy that idle escrow reserves are deployed into.
#[contract]
pub struct YieldVaultContract;

#[contractimpl]
impl YieldVaultContract {
    /* ------------------------------ views ----------------------------- */

    pub fn total_shares(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&VaultDataKey::TotalShares)
            .unwrap_or(0)
    }

    pub fn total_assets(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&VaultDataKey::TotalAssets)
            .unwrap_or(0)
    }

    pub fn share_balance(env: Env, provider: Address) -> i128 {
        env.storage()
            .instance()
            .get(&VaultDataKey::Share(provider))
            .unwrap_or(0)
    }

    /// Current share exchange rate scaled by RATE_SCALE. A fresh vault
    /// (no shares outstanding) reports 1:1.
    pub fn exchange_rate(env: Env) -> i128 {
        let shares = Self::total_shares(env.clone());
        let assets = Self::total_assets(env);
        rate_scaled(assets, shares)
    }

    /* ---------------------------- mutative ---------------------------- */

    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), YieldError> {
        if env.storage().instance().has(&VaultDataKey::Admin) {
            return Err(YieldError::AlreadyInitialized);
        }
        env.storage().instance().set(&VaultDataKey::Admin, &admin);
        env.storage().instance().set(&VaultDataKey::Token, &token);
        env.storage().instance().set(&VaultDataKey::TotalShares, &0i128);
        env.storage().instance().set(&VaultDataKey::TotalAssets, &0i128);
        Ok(())
    }

    /// Deposit `amount` underlying tokens that the provider has ALREADY
    /// pushed to this vault, minting pro-rata shares.
    ///
    /// Push-model with a balance-delta guard: the function verifies the
    /// vault's actual token balance covers the newly attributed assets, so
    /// shares can never be minted against phantom inflows. Pushing (rather
    /// than pulling) is what lets ANY owner deposit — including another
    /// contract like the escrow, which cannot be forced through a bare
    /// `transfer` initiated by someone else, and spares EOAs from managing
    /// SAC allowances.
    pub fn deposit(env: Env, provider: Address, amount: i128) -> Result<i128, YieldError> {
        if amount <= 0 {
            return Err(YieldError::InvalidAmount);
        }
        provider.require_auth();

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&VaultDataKey::Token)
            .ok_or(YieldError::NotInitialized)?;
        let shares_before = Self::total_shares(env.clone());
        let assets_before = Self::total_assets(env.clone());
        let rate_before = rate_scaled(assets_before, shares_before);

        // The pool only credits inflows it can actually see in its balance.
        let untracked_inflow =
            token::Client::new(&env, &token_addr).balance(&env.current_contract_address())
                - assets_before;
        if untracked_inflow < amount {
            // Nothing (or not enough) was pushed — refuse to mint air.
            return Err(YieldError::InvalidAmount);
        }

        let minted = assets_to_shares(amount, assets_before, shares_before);
        let shares_after = shares_before + minted;
        let assets_after = assets_before + amount;
        ensure_rate_not_decreasing(rate_before, rate_scaled(assets_after, shares_after))?;

        env.storage()
            .instance()
            .set(&VaultDataKey::TotalShares, &shares_after);
        env.storage()
            .instance()
            .set(&VaultDataKey::TotalAssets, &assets_after);
        let balance = Self::share_balance(env.clone(), provider.clone());
        env.storage()
            .instance()
            .set(&VaultDataKey::Share(provider.clone()), &(balance + minted));

        env.events().publish(
            (Symbol::new(&env, "vlt_dep"), provider),
            (amount, minted, rate_scaled(assets_after, shares_after)),
        );
        Ok(minted)
    }

/// Burn `shares` and receive the corresponding underlying assets at the
/// current rate. Doubles as the instant-recall leg of the liquidity buffer:
/// settlement demand invokes it against the escrow's own position (wrapped
/// permissionlessly by `EscrowContract::recall_from_vault` below).
pub fn withdraw(env: Env, provider: Address, shares: i128) -> Result<i128, YieldError> {
    if shares <= 0 {
        return Err(YieldError::InvalidAmount);
    }
    provider.require_auth();

    let token_addr: Address = env
        .storage()
        .instance()
        .get(&VaultDataKey::Token)
        .ok_or(YieldError::NotInitialized)?;
    let shares_before = Self::total_shares(env.clone());
    let assets_before = Self::total_assets(env.clone());
    let rate_before = rate_scaled(assets_before, shares_before);

    let balance = Self::share_balance(env.clone(), provider.clone());
    if balance < shares {
        return Err(YieldError::InsufficientShares);
    }

    let payout = shares_to_assets(shares, assets_before, shares_before);
    if payout <= 0 {
        // Burning shares for a zero payout silently destroys value.
        return Err(YieldError::InvalidAmount);
    }

    let shares_after = shares_before - shares;
    let assets_after = assets_before - payout;
    // A fully-exited pool legitimately resets to the fresh-vault sentinel
    // (1:1); the monotonicity rule only binds while depositors remain to be
    // protected by it.
    if shares_after > 0 {
        ensure_rate_not_decreasing(rate_before, rate_scaled(assets_after, shares_after))?;
    }

    env.storage()
        .instance()
        .set(&VaultDataKey::TotalShares, &shares_after);
    env.storage()
        .instance()
        .set(&VaultDataKey::TotalAssets, &assets_after);
    env.storage()
        .instance()
        .set(&VaultDataKey::Share(provider.clone()), &(balance - shares));

    token::Client::new(&env, &token_addr).transfer(
        &env.current_contract_address(),
        &provider,
        &payout,
    );

    env.events().publish(
        (Symbol::new(&env, "vlt_wdr"), provider),
        (shares, payout),
    );
    Ok(payout)
}

/// Settle one harvest: pull `amount` of accrued strategy yield into the
/// vault. Shares outstanding are unchanged, so the exchange rate rises and
/// every depositor's claim appreciates proportionally — the exact operation
/// the "rate must never decrease" invariant protects. Returns the new
/// scaled rate.
pub fn harvest(env: Env, strategy: Address, amount: i128) -> Result<i128, YieldError> {
    if amount <= 0 {
        return Err(YieldError::InvalidYield);
    }
    strategy.require_auth();

    let token_addr: Address = env
        .storage()
        .instance()
        .get(&VaultDataKey::Token)
        .ok_or(YieldError::NotInitialized)?;
    let shares_before = Self::total_shares(env.clone());
    let assets_before = Self::total_assets(env.clone());
    let rate_before = rate_scaled(assets_before, shares_before);

    token::Client::new(&env, &token_addr).transfer(
        &strategy,
        &env.current_contract_address(),
        &amount,
    );

    let assets_after = assets_before + amount;
    ensure_rate_not_decreasing(rate_before, rate_scaled(assets_after, shares_before))?;

    env.storage()
        .instance()
        .set(&VaultDataKey::TotalAssets, &assets_after);

    let new_rate = rate_scaled(assets_after, shares_before);
    env.events().publish(
        (Symbol::new(&env, "vlt_hrv"), strategy),
        (amount, new_rate),
    );
    Ok(new_rate)
}
}

fn rate_scaled(total_assets: i128, total_shares: i128) -> i128 {
    if total_shares <= 0 {
        RATE_SCALE
    } else {
        (total_assets * RATE_SCALE) / total_shares
    }
}

/// Round DOWN when converting assets to shares so a depositor can never
/// receive more than their assets are worth — rounding dust accrues to the
/// vault and nudges the rate up instead of down.
fn assets_to_shares(assets: i128, total_assets: i128, total_shares: i128) -> i128 {
    if total_assets <= 0 || total_shares <= 0 {
        // Fresh vault: 1:1.
        assets
    } else {
        (assets * total_shares) / total_assets
    }
}

/// Round DOWN payouts so a withdrawing depositor can never take more than
/// their pro-rata slice — residual dust stays and pushes the rate up.
fn shares_to_assets(shares: i128, total_assets: i128, total_shares: i128) -> i128 {
    if total_shares <= 0 {
        shares
    } else {
        (shares * total_assets) / total_shares
    }
}

fn ceil_div(numer: i128, denom: i128) -> i128 {
    (numer + denom - 1) / denom
}

fn ensure_rate_not_decreasing(before: i128, after: i128) -> Result<(), YieldError> {
    if after < before {
        Err(YieldError::RateWouldDecrease)
    } else {
        Ok(())
    }
}
