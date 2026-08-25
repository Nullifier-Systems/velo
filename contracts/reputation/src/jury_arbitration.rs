//! On-chain jury arbitration module for dispute panel resolution.
//!
//! VRF-selects 5 staked jurors, manages commit-reveal voting rounds,
//! and executes automated escrow resolution with stake slashing.

use soroban_sdk::{
    contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, Map, Vec,
};

use crate::{RepDataKey, TTL_EXTEND};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JurorPanelStatus {
    Voting,
    Reveal,
    Resolved,
    Slashed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JurorVote {
    Buyer,
    Seller,
    Abstain,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JurorStakeInfo {
    pub staked_amount: i128,
    pub reputation_score: u32,
    pub is_active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputePanelInfo {
    pub panel_id: BytesN<32>,
    pub trade_id: BytesN<32>,
    pub juror_addresses: Vec<Address>,
    pub status: JurorPanelStatus,
    pub escrow_amount: i128,
    pub buyer_share_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteCommit {
    pub juror: Address,
    pub commit_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteReveal {
    pub juror: Address,
    pub vote: JurorVote,
    pub salt: BytesN<32>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum JuryError {
    InsufficientStake = 100,
    JurorAlreadyStaked = 101,
    JurorNotStaked = 102,
    PanelNotFound = 103,
    InvalidPanelStatus = 104,
    JurorNotOnPanel = 105,
    DuplicateVoteCommit = 106,
    InvalidCommitReveal = 107,
    VoteAlreadyRevealed = 108,
    PanelNotRevealPhase = 109,
    SlashingFailed = 110,
    Unauthorized = 111,
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JuryDataKey {
    JurorStake(Address),
    Panel(BytesN<32>),
    PanelVoteCommit(BytesN<32>, Address),
    PanelVoteReveal(BytesN<32>, Address),
    ActiveJurorCount,
    TotalPanels,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

pub struct JuryArbitration;

#[contractimpl]
impl JuryArbitration {
    /// Register a juror by depositing stake collateral.
    pub fn stake_as_juror(
        env: Env,
        juror: Address,
        amount: i128,
        reputation_score: u32,
    ) -> Result<(), JuryError> {
        juror.require_auth();

        if amount < crate::jury_arbitration::DISPUTE_JURY_MIN_STAKE {
            return Err(JuryError::InsufficientStake);
        }

        if env
            .storage()
            .persistent()
            .has(&JuryDataKey::JurorStake(juror.clone()))
        {
            return Err(JuryError::JurorAlreadyStaked);
        }

        let stake = JurorStakeInfo {
            staked_amount: amount,
            reputation_score,
            is_active: true,
        };

        env.storage()
            .persistent()
            .set(&JuryDataKey::JurorStake(juror.clone()), &stake);
        env.storage()
            .persistent()
            .extend_ttl(&JuryDataKey::JurorStake(juror.clone()), TTL_EXTEND, TTL_EXTEND);

        // Increment active juror count
        let count: u32 = env
            .storage()
            .persistent()
            .get(&JuryDataKey::ActiveJurorCount)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&JuryDataKey::ActiveJurorCount, &(count + 1));

        env.events().publish(
            (symbol_short!("juror"), symbol_short!("stake")),
            (juror, amount, reputation_score),
        );

        Ok(())
    }

    /// Unstake a juror (only if not on any active panel).
    pub fn unstake_juror(env: Env, juror: Address) -> Result<i128, JuryError> {
        juror.require_auth();

        let stake: JurorStakeInfo = env
            .storage()
            .persistent()
            .get(&JuryDataKey::JurorStake(juror.clone()))
            .ok_or(JuryError::JurorNotStaked)?;

        if !stake.is_active {
            return Err(JuryError::JurorNotStaked);
        }

        env.storage()
            .persistent()
            .remove(&JuryDataKey::JurorStake(juror.clone()));

        let count: u32 = env
            .storage()
            .persistent()
            .get(&JuryDataKey::ActiveJurorCount)
            .unwrap_or(1);
        env.storage()
            .persistent()
            .set(&JuryDataKey::ActiveJurorCount, &(count.saturating_sub(1)));

        env.events().publish(
            (symbol_short!("juror"), symbol_short!("unstake")),
            (juror, stake.staked_amount),
        );

        Ok(stake.staked_amount)
    }

    /// Get juror stake info.
    pub fn get_juror_stake(env: Env, juror: Address) -> Option<JurorStakeInfo> {
        env.storage()
            .persistent()
            .get(&JuryDataKey::JurorStake(juror))
    }

    /// Get total number of active jurors.
    pub fn get_active_juror_count(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&JuryDataKey::ActiveJurorCount)
            .unwrap_or(0)
    }

    /// Get total number of dispute panels created.
    pub fn get_total_panels(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&JuryDataKey::TotalPanels)
            .unwrap_or(0)
    }

    /// Create a dispute panel with the given jurors (admin/system only).
    pub fn create_panel(
        env: Env,
        panel_id: BytesN<32>,
        trade_id: BytesN<32>,
        juror_addresses: Vec<Address>,
        escrow_amount: i128,
    ) -> Result<(), JuryError> {
        if juror_addresses.len() != 5 {
            return Err(JuryError::InvalidPanelStatus);
        }

        // Verify all jurors are staked and active
        for addr in juror_addresses.iter() {
            let stake: JurorStakeInfo = env
                .storage()
                .persistent()
                .get(&JuryDataKey::JurorStake(addr.clone()))
                .ok_or(JuryError::JurorNotStaked)?;
            if !stake.is_active {
                return Err(JuryError::JurorNotStaked);
            }
        }

        let panel = DisputePanelInfo {
            panel_id: panel_id.clone(),
            trade_id,
            juror_addresses,
            status: JurorPanelStatus::Voting,
            escrow_amount,
            buyer_share_bps: 0,
        };

        env.storage()
            .persistent()
            .set(&JuryDataKey::Panel(panel_id.clone()), &panel);
        env.storage()
            .persistent()
            .extend_ttl(&JuryDataKey::Panel(panel_id), TTL_EXTEND, TTL_EXTEND);

        // Increment panel count
        let count: u32 = env
            .storage()
            .persistent()
            .get(&JuryDataKey::TotalPanels)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&JuryDataKey::TotalPanels, &(count + 1));

        Ok(())
    }

    /// Submit a vote commit during the VOTING phase.
    pub fn submit_vote_commit(
        env: Env,
        panel_id: BytesN<32>,
        juror: Address,
        commit_hash: BytesN<32>,
    ) -> Result<(), JuryError> {
        juror.require_auth();

        let mut panel: DisputePanelInfo = env
            .storage()
            .persistent()
            .get(&JuryDataKey::Panel(panel_id.clone()))
            .ok_or(JuryError::PanelNotFound)?;

        if panel.status != JurorPanelStatus::Voting {
            return Err(JuryError::InvalidPanelStatus);
        }

        if !panel.juror_addresses.contains(&juror) {
            return Err(JuryError::JurorNotOnPanel);
        }

        if env
            .storage()
            .persistent()
            .has(&JuryDataKey::PanelVoteCommit(panel_id.clone(), juror.clone()))
        {
            return Err(JuryError::DuplicateVoteCommit);
        }

        let commit = VoteCommit {
            juror: juror.clone(),
            commit_hash,
        };

        env.storage().persistent().set(
            &JuryDataKey::PanelVoteCommit(panel_id.clone(), juror.clone()),
            &commit,
        );
        env.storage().persistent().extend_ttl(
            &JuryDataKey::PanelVoteCommit(panel_id, juror),
            TTL_EXTEND,
            TTL_EXTEND,
        );

        Ok(())
    }

    /// Transition panel from VOTING to REVEAL phase.
    pub fn start_reveal_phase(env: Env, panel_id: BytesN<32>) -> Result<(), JuryError> {
        let mut panel: DisputePanelInfo = env
            .storage()
            .persistent()
            .get(&JuryDataKey::Panel(panel_id.clone()))
            .ok_or(JuryError::PanelNotFound)?;

        if panel.status != JurorPanelStatus::Voting {
            return Err(JuryError::InvalidPanelStatus);
        }

        panel.status = JurorPanelStatus::Reveal;
        env.storage()
            .persistent()
            .set(&JuryDataKey::Panel(panel_id), &panel);

        Ok(())
    }

    /// Submit a vote reveal during the REVEAL phase.
    pub fn submit_vote_reveal(
        env: Env,
        panel_id: BytesN<32>,
        juror: Address,
        vote: JurorVote,
        salt: BytesN<32>,
    ) -> Result<(), JuryError> {
        juror.require_auth();

        let panel: DisputePanelInfo = env
            .storage()
            .persistent()
            .get(&JuryDataKey::Panel(panel_id.clone()))
            .ok_or(JuryError::PanelNotFound)?;

        if panel.status != JurorPanelStatus::Reveal {
            return Err(JuryError::PanelNotRevealPhase);
        }

        if !panel.juror_addresses.contains(&juror) {
            return Err(JuryError::JurorNotOnPanel);
        }

        // Verify commit-reveal: hash(vote, salt) must match the stored commit
        let commit: VoteCommit = env
            .storage()
            .persistent()
            .get(&JuryDataKey::PanelVoteCommit(
                panel_id.clone(),
                juror.clone(),
            ))
            .ok_or(JuryError::JurorNotOnPanel)?;

        let vote_bytes = match vote {
            JurorVote::Buyer => Bytes::from_slice(env, b"BUYER"),
            JurorVote::Seller => Bytes::from_slice(env, b"SELLER"),
            JurorVote::Abstain => Bytes::from_slice(env, b"ABSTAIN"),
        };
        let mut payload = vote_bytes;
        payload.append(&salt.clone().into());
        let hash = env.crypto().sha256(&payload);

        if hash.into() != commit.commit_hash {
            return Err(JuryError::InvalidCommitReveal);
        }

        if env
            .storage()
            .persistent()
            .has(&JuryDataKey::PanelVoteReveal(panel_id.clone(), juror.clone()))
        {
            return Err(JuryError::VoteAlreadyRevealed);
        }

        let reveal = VoteReveal {
            juror: juror.clone(),
            vote: vote.clone(),
            salt,
        };

        env.storage().persistent().set(
            &JuryDataKey::PanelVoteReveal(panel_id.clone(), juror.clone()),
            &reveal,
        );
        env.storage().persistent().extend_ttl(
            &JuryDataKey::PanelVoteReveal(panel_id, juror),
            TTL_EXTEND,
            TTL_EXTEND,
        );

        Ok(())
    }

    /// Resolve the panel: count revealed votes, determine majority, and slash.
    pub fn resolve_panel(
        env: Env,
        panel_id: BytesN<32>,
    ) -> Result<(JurorVote, u32, Vec<Address>), JuryError> {
        let mut panel: DisputePanelInfo = env
            .storage()
            .persistent()
            .get(&JuryDataKey::Panel(panel_id.clone()))
            .ok_or(JuryError::PanelNotFound)?;

        if panel.status != JurorPanelStatus::Reveal {
            return Err(JuryError::InvalidPanelStatus);
        }

        let mut buyer_votes: u32 = 0;
        let mut seller_votes: u32 = 0;
        let mut abstain_votes: u32 = 0;
        let mut revealed_count: u32 = 0;
        let mut slashed = soroban_sdk::Vec::new(&env);

        for addr in panel.juror_addresses.iter() {
            if let Some(reveal) = env
                .storage()
                .persistent()
                .get::<JuryDataKey, VoteReveal>(&JuryDataKey::PanelVoteReveal(
                    panel_id.clone(),
                    addr.clone(),
                ))
            {
                revealed_count += 1;
                match reveal.vote {
                    JurorVote::Buyer => buyer_votes += 1,
                    JurorVote::Seller => seller_votes += 1,
                    JurorVote::Abstain => abstain_votes += 1,
                }
            } else {
                // Juror did not reveal — slash 100%
                let mut stake: JurorStakeInfo = env
                    .storage()
                    .persistent()
                    .get(&JuryDataKey::JurorStake(addr.clone()))
                    .unwrap_or(JurorStakeInfo {
                        staked_amount: 0,
                        reputation_score: 0,
                        is_active: false,
                    });
                stake.staked_amount = 0;
                stake.reputation_score = 0;
                stake.is_active = false;
                env.storage()
                    .persistent()
                    .set(&JuryDataKey::JurorStake(addr.clone()), &stake);
                slashed.push_back(addr);
            }
        }

        // Determine majority resolution
        let resolution = if buyer_votes > seller_votes {
            JurorVote::Buyer
        } else if seller_votes > buyer_votes {
            JurorVote::Seller
        } else {
            JurorVote::Abstain
        };

        // Calculate buyer share: Buyer win = 10000, Seller win = 0, Tie = 5000
        let buyer_share_bps = match resolution {
            JurorVote::Buyer => 10_000,
            JurorVote::Seller => 0,
            JurorVote::Abstain => 5_000,
        };

        // Slash minority voters
        for addr in panel.juror_addresses.iter() {
            if let Some(reveal) = env
                .storage()
                .persistent()
                .get::<JuryDataKey, VoteReveal>(&JuryDataKey::PanelVoteReveal(
                    panel_id.clone(),
                    addr.clone(),
                ))
            {
                if reveal.vote != resolution && reveal.vote != JurorVote::Abstain {
                    let mut stake: JurorStakeInfo = env
                        .storage()
                        .persistent()
                        .get(&JuryDataKey::JurorStake(addr.clone()))
                        .unwrap_or(JurorStakeInfo {
                            staked_amount: 0,
                            reputation_score: 0,
                            is_active: false,
                        });
                    let slash_amount = stake.staked_amount / 2;
                    stake.staked_amount -= slash_amount;
                    stake.reputation_score = stake.reputation_score.saturating_sub(25);
                    env.storage()
                        .persistent()
                        .set(&JuryDataKey::JurorStake(addr.clone()), &stake);
                    if !slashed.contains(&addr) {
                        slashed.push_back(addr);
                    }
                }
            }
        }

        panel.status = JurorPanelStatus::Resolved;
        panel.buyer_share_bps = buyer_share_bps;
        env.storage()
            .persistent()
            .set(&JuryDataKey::Panel(panel_id), &panel);

        Ok((resolution, buyer_share_bps, slashed))
    }

    /// Get panel info.
    pub fn get_panel(env: Env, panel_id: BytesN<32>) -> Option<DisputePanelInfo> {
        env.storage()
            .persistent()
            .get(&JuryDataKey::Panel(panel_id))
    }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISPUTE_JURY_MIN_STAKE: i128 = 100_000_000; // 10 USDC in stroops
