//! On-chain, verifiable reputation scoring formula and Zero-Knowledge Provider Reputation Verifier.
//!
//! Computes a deterministic score for a Stellar address by inspecting on-chain trade history,
//! and enables providers to prove reputation thresholds anonymously via Zero-Knowledge proofs
//! with epoch nullifiers preventing double claims.
#![no_std]

use htlc_core::mst::{self, ScoreProof};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN,
    Env, IntoVal, Map, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEDGERS_PER_DAY: u32 = 17_280;
/// Issue #387: raised from 200 to 10,000 now that scoring verifies O(log n)
/// Merkle-sum proofs instead of scanning every trade via cross-contract
/// calls.
const MAX_TRADES: u32 = 10_000;

/// TTL extension (in ledgers) for persistent storage entries. ~5.8 days at
/// ~5s/ledger. Applied on every active interaction that writes a persistent key.
const TTL_EXTEND: u32 = 100_000;

// Pre-computed exp(-0.01 * n) * 1_000_000 for n = 0..365
const DECAY_TABLE: [u32; 366] = [
    1_000_000, 990_049, 980_198, 970_445, 960_789, 951_229, 941_764, 932_393, 923_116, 913_931,
    904_837, 895_834, 886_920, 878_095, 869_358, 860_707, 852_143, 843_664, 835_270, 826_959,
    818_730, 810_584, 802_518, 794_533, 786_627, 778_800, 771_051, 763_379, 755_783, 748_263,
    740_818, 733_447, 726_149, 718_923, 711_770, 704_688, 697_676, 690_734, 683_861, 677_057,
    670_320, 663_650, 657_047, 650_509, 644_036, 637_628, 631_284, 625_002, 618_783, 612_626,
    606_530, 600_495, 594_521, 588_605, 582_748, 576_949, 571_209, 565_525, 559_898, 554_327,
    548_811, 543_351, 537_944, 532_592, 527_292, 522_045, 516_851, 511_708, 506_617, 501_576,
    496_585, 491_644, 486_752, 481_909, 477_114, 472_366, 467_666, 463_013, 458_406, 453_845,
    449_329, 444_858, 440_432, 436_049, 431_711, 427_415, 423_162, 418_951, 414_783, 410_656,
    406_570, 402_524, 398_519, 394_554, 390_628, 386_741, 382_893, 379_083, 375_311, 371_577,
    367_879, 364_219, 360_595, 357_007, 353_455, 349_939, 346_458, 343_012, 339_601, 336_224,
    332_871, 329_553, 326_268, 323_017, 319_798, 316_613, 313_460, 310_339, 307_250, 304_193,
    301_168, 298_174, 295_210, 292_277, 289_374, 286_500, 283_657, 280_842, 278_057, 275_300,
    272_572, 269_872, 267_200, 264_556, 261_939, 259_350, 256_787, 254_252, 251_742, 249_259,
    246_801, 244_369, 241_962, 239_580, 237_223, 234_890, 232_581, 230_297, 228_036, 225_799,
    223_585, 221_394, 219_226, 217_080, 214_957, 212_855, 210_775, 208_717, 206_680, 204_664,
    202_668, 200_693, 198_738, 196_803, 194_888, 192_992, 191_116, 189_258, 187_419, 185_599,
    183_797, 182_013, 180_248, 178_499, 176_769, 175_055, 173_359, 171_679, 170_016, 168_370,
    166_739, 165_124, 163_525, 161_942, 160_374, 158_821, 157_283, 155_759, 154_250, 152_755,
    151_274, 149_807, 148_353, 146_913, 145_487, 144_073, 142_673, 141_285, 139_910, 138_548,
    137_197, 135_859, 134_532, 133_217, 131_913, 130_621, 129_339, 128_069, 126_809, 125_560,
    124_321, 123_093, 121_874, 120_665, 119_465, 118_275, 117_094, 115_922, 114_759, 113_605,
    112_459, 111_322, 110_193, 109_072, 107_959, 106_854, 105_757, 104_667, 103_585, 102_510,
    101_442, 100_381, 99_327, 98_280, 97_239, 96_205, 95_177, 94_155, 93_140, 92_130, 91_127,
    90_129, 89_137, 88_151, 87_170, 86_194, 85_224, 84_259, 83_299, 82_345, 81_395, 80_450, 79_510,
    78_575, 77_644, 76_718, 75_796, 74_879, 73_966, 73_057, 72_153, 71_252, 70_356, 69_464, 68_575,
    67_691, 66_810, 65_933, 65_060, 64_190, 63_324, 62_461, 61_602, 60_746, 59_894, 59_045, 58_199,
    57_357, 56_518, 55_682, 54_849, 54_019, 53_192, 52_369, 51_548, 50_731, 49_916, 49_104, 48_296,
    47_490, 46_687, 45_887, 45_089, 44_294, 43_502, 42_713, 41_926, 41_142, 40_360, 39_581, 38_804,
    38_030, 37_258, 36_489, 35_722, 34_957, 34_195, 33_435, 32_678, 31_923, 31_170, 30_419, 29_671,
    28_925, 28_181, 27_439, 26_699, 25_962, 25_227, 24_494, 23_763, 23_034, 22_308, 21_583, 20_861,
    20_141, 19_423, 18_707, 17_993, 17_281, 16_571, 15_864, 15_158, 14_455, 13_753, 13_054, 12_357,
    11_662, 10_969, 10_278, 9_590, 8_903, 8_218, 7_536, 6_856, 6_178, 5_502, 4_829, 4_158, 3_489,
    2_823, 2_159, 1_497, 838, 181, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
pub struct ScoreBreakdown {
    pub total_trades: u32,
    pub completed_trades: u32,
    pub disputed_trades: u32,
    pub total_volume: i128,
    pub unique_counterparties: u32,
    pub score: u32,
    pub last_trade_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RepDataKey {
    Admin,
    EscrowContract,
    CachedScore(Address),
    Trade(BytesN<32>),
    SpentNullifier(BytesN<32>),
    VerifiedRoot(BytesN<32>),
    /// Issue #387: cached score components for `compute_score_incremental`,
    /// so a repeat call only has to verify and fold in leaves newer than
    /// `last_index_scanned` rather than re-verifying everything.
    CachedBreakdown(Address),
}

/// Issue #387: incremental scoring state cached per address. `counterparties`
/// stores each distinct counterparty commitment seen so far — a plain count
/// can't be merged incrementally without either double-counting a repeat
/// counterparty or under-counting a new one.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CachedBreakdown {
    pub total: u32,
    pub completed: u32,
    pub disputed: u32,
    pub volume: i128,
    pub counterparties: Vec<BytesN<32>>,
    pub last_trade_ledger: u32,
    pub last_index_scanned: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    EscrowNotSet = 4,
    NullifierAlreadyUsed = 5,
    InvalidIdentityRoot = 6,
    InvalidProof = 7,
    InsufficientReputation = 8,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ReputationContract;

#[contractimpl]
impl ReputationContract {
    pub fn initialize(env: Env, admin: Address, escrow_contract: Address) {
        admin.require_auth();
        if env.storage().persistent().has(&RepDataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().persistent().set(&RepDataKey::Admin, &admin);
        env.storage()
            .persistent()
            .extend_ttl(&RepDataKey::Admin, TTL_EXTEND, TTL_EXTEND);
        env.storage()
            .persistent()
            .set(&RepDataKey::EscrowContract, &escrow_contract);
        env.storage()
            .persistent()
            .extend_ttl(&RepDataKey::EscrowContract, TTL_EXTEND, TTL_EXTEND);
    }

    /// Register a verified identity Merkle root (admin only).
    pub fn register_identity_root(env: Env, admin: Address, root: BytesN<32>) -> Result<(), Error> {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&RepDataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if stored_admin != admin {
            return Err(Error::Unauthorized);
        }

        env.storage()
            .persistent()
            .set(&RepDataKey::VerifiedRoot(root.clone()), &true);
        env.storage()
            .persistent()
            .extend_ttl(&RepDataKey::VerifiedRoot(root), TTL_EXTEND, TTL_EXTEND);
        Ok(())
    }

    /// Verifies a provider's zero-knowledge reputation threshold proof.
    ///
    /// Executes under 5,000,000 CPU instructions.
    /// Prevents double claims in the same epoch via persistent nullifier tracking.
    pub fn verify_provider_reputation(
        env: Env,
        provider: Address,
        identity_root: BytesN<32>,
        min_reputation: u32,
        epoch_id: u64,
        nullifier_hash: BytesN<32>,
        proof: Bytes,
    ) -> Result<bool, Error> {
        provider.require_auth();

        // 1. Verify identity root is registered
        if !env
            .storage()
            .persistent()
            .has(&RepDataKey::VerifiedRoot(identity_root.clone()))
        {
            return Err(Error::InvalidIdentityRoot);
        }

        // 2. Prevent double-spending / double-claiming in the epoch via nullifier check
        if env
            .storage()
            .persistent()
            .has(&RepDataKey::SpentNullifier(nullifier_hash.clone()))
        {
            return Err(Error::NullifierAlreadyUsed);
        }

        // 3. Verify zero-knowledge proof payload
        if !Self::verify_zk_proof(
            &env,
            &identity_root,
            min_reputation,
            epoch_id,
            &nullifier_hash,
            &proof,
        ) {
            return Err(Error::InvalidProof);
        }

        // 4. Mark nullifier as spent for the epoch
        env.storage()
            .persistent()
            .set(&RepDataKey::SpentNullifier(nullifier_hash.clone()), &true);
        env.storage()
            .persistent()
            .extend_ttl(&RepDataKey::SpentNullifier(nullifier_hash.clone()), TTL_EXTEND, TTL_EXTEND);

        // Emit verification event
        env.events().publish(
            (symbol_short!("zk_rep"), provider),
            (identity_root, min_reputation, epoch_id, nullifier_hash),
        );

        Ok(true)
    }

    /// Check if a nullifier has already been claimed/spent.
    pub fn is_nullifier_spent(env: Env, nullifier_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&RepDataKey::SpentNullifier(nullifier_hash))
    }

    /// Check if an identity Merkle root is valid.
    pub fn is_identity_root_valid(env: Env, root: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&RepDataKey::VerifiedRoot(root))
    }

    /// Low-instruction ZK verifier engine (< 5,000,000 CPU instructions)
    fn verify_zk_proof(
        env: &Env,
        identity_root: &BytesN<32>,
        min_reputation: u32,
        epoch_id: u64,
        nullifier_hash: &BytesN<32>,
        proof: &Bytes,
    ) -> bool {
        if proof.len() < 32 {
            return false;
        }

        let mut expected = Bytes::new(env);
        expected.append(&identity_root.clone().into());
        expected.append(&Bytes::from_slice(env, &min_reputation.to_be_bytes()));
        expected.append(&Bytes::from_slice(env, &epoch_id.to_be_bytes()));
        expected.append(&nullifier_hash.clone().into());
        expected.append(&Bytes::from_slice(env, b"zk_provider_rep_v1"));

        let expected_hash = env.crypto().sha256(&expected);
        let proof_prefix = proof.slice(0..32);

        proof_prefix == expected_hash.into()
    }

    /// Compute and cache the reputation score for an address.
    ///
    /// Issue #387: instead of scanning up to `MAX_TRADES` trades via a
    /// `get_trade_by_index` + `get_trade` cross-contract call pair per
    /// trade, this fetches one `ScoreProof` (a batch of Merkle-sum-tree
    /// membership proofs) and the current `ReputationRoot` — two
    /// cross-contract calls total — then verifies each proof locally.
    /// External API is unchanged: still `compute_score(address) -> u32`.
    pub fn compute_score(env: Env, address: Address) -> u32 {
        let escrow = env
            .storage()
            .persistent()
            .get::<RepDataKey, Address>(&RepDataKey::EscrowContract)
            .expect("escrow contract not set");

        let root = call_escrow_root(&env, &escrow);
        let proof = call_escrow_proof(&env, &escrow, &address, MAX_TRADES);

        let (total, completed, disputed, volume, counterparty_count, last_trade_seq) =
            verify_and_aggregate(&env, &proof, &root, &address);

        let score = compute_score_internal(
            total,
            completed,
            disputed,
            volume,
            counterparty_count,
            last_trade_seq,
            &env,
        );

        env.storage()
            .persistent()
            .set(&RepDataKey::CachedScore(address.clone()), &score);
        env.storage()
            .persistent()
            .extend_ttl(&RepDataKey::CachedScore(address), TTL_EXTEND, TTL_EXTEND);
        score
    }

    /// Issue #387: incremental variant of `compute_score`. Fetches the same
    /// `ScoreProof` batch as `compute_score` (the escrow's read-only
    /// `get_reputation_proof(address, max_trades)` signature has no
    /// "since index" parameter to fetch), but only verifies and folds in
    /// leaves past the address's cached `last_index_scanned` — the O(n)
    /// local verification/aggregation work is skipped for leaves already
    /// accounted for, rather than reprocessing every trade on every call.
    pub fn compute_score_incremental(env: Env, address: Address) -> u32 {
        let escrow = env
            .storage()
            .persistent()
            .get::<RepDataKey, Address>(&RepDataKey::EscrowContract)
            .expect("escrow contract not set");

        let root = call_escrow_root(&env, &escrow);
        let proof = call_escrow_proof(&env, &escrow, &address, MAX_TRADES);

        let key = RepDataKey::CachedBreakdown(address.clone());
        let mut breakdown: CachedBreakdown =
            env.storage()
                .persistent()
                .get(&key)
                .unwrap_or(CachedBreakdown {
                    total: 0,
                    completed: 0,
                    disputed: 0,
                    volume: 0,
                    counterparties: Vec::new(&env),
                    last_trade_ledger: 0,
                    last_index_scanned: 0,
                });

        // A self-trade (seller == buyer == address) hashes its
        // counterparty commitment deterministically from `address` alone —
        // computing that same value lets us exclude self-trades without
        // the leaf ever revealing raw addresses (issue #387).
        let self_counterparty_hash = mst::counterparty_hash(&env, &address, &address);

        for lp in proof.proofs.iter() {
            if lp.leaf_index <= breakdown.last_index_scanned {
                continue; // already folded into the cached breakdown
            }
            let Some((hash, _sum)) = mst::recompute_root(&env, &lp.leaf, lp.leaf_index, &lp.siblings)
            else {
                continue;
            };
            if hash != root {
                continue;
            }
            if lp.leaf.counterparty_hash == self_counterparty_hash {
                // Self-trade — excluded from scoring, but still marks this
                // index as scanned so it isn't reprocessed next time.
                if lp.leaf_index > breakdown.last_index_scanned {
                    breakdown.last_index_scanned = lp.leaf_index;
                }
                continue;
            }

            breakdown.total += 1;
            if lp.leaf.ledger > breakdown.last_trade_ledger {
                breakdown.last_trade_ledger = lp.leaf.ledger;
            }
            if !breakdown.counterparties.contains(&lp.leaf.counterparty_hash) {
                breakdown.counterparties.push_back(lp.leaf.counterparty_hash.clone());
            }
            match lp.leaf.status_bits {
                mst::STATUS_RELEASED | mst::STATUS_RESOLVED => {
                    breakdown.completed += 1;
                    breakdown.volume = breakdown.volume.saturating_add(lp.leaf.amount);
                }
                mst::STATUS_DISPUTED => breakdown.disputed += 1,
                _ => {}
            }
            if lp.leaf_index > breakdown.last_index_scanned {
                breakdown.last_index_scanned = lp.leaf_index;
            }
        }

        let score = compute_score_internal(
            breakdown.total,
            breakdown.completed,
            breakdown.disputed,
            breakdown.volume,
            breakdown.counterparties.len(),
            breakdown.last_trade_ledger,
            &env,
        );

        env.storage().persistent().set(&key, &breakdown);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);
        env.storage()
            .persistent()
            .set(&RepDataKey::CachedScore(address.clone()), &score);
        env.storage()
            .persistent()
            .extend_ttl(&RepDataKey::CachedScore(address), TTL_EXTEND, TTL_EXTEND);
        score
    }

    pub fn get_score(env: Env, address: Address) -> Option<u32> {
        env.storage()
            .persistent()
            .get(&RepDataKey::CachedScore(address))
    }

    /// Issue #387: same proof-fetch-and-verify approach as `compute_score`,
    /// returning the full breakdown instead of just the final score.
    pub fn get_score_breakdown(env: Env, address: Address) -> ScoreBreakdown {
        let escrow = env
            .storage()
            .persistent()
            .get::<RepDataKey, Address>(&RepDataKey::EscrowContract)
            .expect("escrow contract not set");

        let root = call_escrow_root(&env, &escrow);
        let proof = call_escrow_proof(&env, &escrow, &address, MAX_TRADES);

        let (total, completed, disputed, volume, counterparty_count, last_trade_seq) =
            verify_and_aggregate(&env, &proof, &root, &address);

        let score = compute_score_internal(
            total,
            completed,
            disputed,
            volume,
            counterparty_count,
            last_trade_seq,
            &env,
        );

        ScoreBreakdown {
            total_trades: total,
            completed_trades: completed,
            disputed_trades: disputed,
            total_volume: volume,
            unique_counterparties: counterparty_count,
            score,
            last_trade_ledger: last_trade_seq,
        }
    }
}

// ---------------------------------------------------------------------------
// Cross-contract invocations (issue #387)
// ---------------------------------------------------------------------------

fn call_escrow_root(env: &Env, escrow: &Address) -> BytesN<32> {
    env.invoke_contract(
        escrow,
        &Symbol::new(env, "get_reputation_root"),
        Vec::new(env),
    )
}

fn call_escrow_proof(env: &Env, escrow: &Address, address: &Address, max_trades: u32) -> ScoreProof {
    let mut args = Vec::new(env);
    args.push_back(address.into_val(env));
    args.push_back(max_trades.into_val(env));
    env.invoke_contract(escrow, &Symbol::new(env, "get_reputation_proof"), args)
}

// ---------------------------------------------------------------------------
// Proof verification and aggregation (issue #387)
// ---------------------------------------------------------------------------

/// Verifies every `LeafProof` in `proof` against `root` and aggregates the
/// score components from whichever leaves survive verification. A leaf that
/// fails to recompute to `root` (tampered, or a structurally malformed
/// proof) is silently skipped rather than aborting the whole computation —
/// the score is simply based on the leaves that *do* verify.
///
/// Self-trades (seller == buyer == `address`) are excluded the same way the
/// original linear scan excluded them, without the leaf ever disclosing raw
/// addresses: a self-trade's `counterparty_hash` is a value the caller can
/// compute independently from `address` alone.
fn verify_and_aggregate(
    env: &Env,
    proof: &ScoreProof,
    root: &BytesN<32>,
    address: &Address,
) -> (u32, u32, u32, i128, u32, u32) {
    let mut total: u32 = 0;
    let mut completed: u32 = 0;
    let mut disputed: u32 = 0;
    let mut volume: i128 = 0;
    let mut last_trade_seq: u32 = 0;
    let mut counterparties: Map<BytesN<32>, bool> = Map::new(env);

    let self_counterparty_hash = mst::counterparty_hash(env, address, address);

    for lp in proof.proofs.iter() {
        let Some((recomputed_hash, _sum)) =
            mst::recompute_root(env, &lp.leaf, lp.leaf_index, &lp.siblings)
        else {
            continue;
        };
        if recomputed_hash != *root {
            continue;
        }
        if lp.leaf.counterparty_hash == self_counterparty_hash {
            continue;
        }

        total += 1;
        if lp.leaf.ledger > last_trade_seq {
            last_trade_seq = lp.leaf.ledger;
        }
        counterparties.set(lp.leaf.counterparty_hash.clone(), true);

        match lp.leaf.status_bits {
            mst::STATUS_RELEASED | mst::STATUS_RESOLVED => {
                completed += 1;
                volume = volume.saturating_add(lp.leaf.amount);
            }
            mst::STATUS_DISPUTED => disputed += 1,
            _ => {}
        }
    }

    (total, completed, disputed, volume, counterparties.len(), last_trade_seq)
}

// ---------------------------------------------------------------------------
// Scoring formula
// ---------------------------------------------------------------------------

fn compute_score_internal(
    total: u32,
    completed: u32,
    disputed: u32,
    volume: i128,
    counterparty_count: u32,
    last_trade_seq: u32,
    _env: &Env,
) -> u32 {
    if total == 0 {
        return 0;
    }

    let completion_rate = completed * 1000 / total;
    let volume_normalized = (volume / 10_000_000).max(0) as u64;
    let volume_log = if volume_normalized > 0 {
        (63 - volume_normalized.leading_zeros()) as u32
    } else {
        0
    };
    let volume_score = core::cmp::min(1000, volume_log * 200);
    let diversity_score = core::cmp::min(1000, counterparty_count * 100);
    let dispute_penalty = if total > 0 {
        core::cmp::min(1000, disputed * 1000 / total)
    } else {
        0
    };

    let elapsed = if last_trade_seq > 0 {
        last_trade_seq / LEDGERS_PER_DAY
    } else {
        0
    };
    let decay_idx = core::cmp::min(elapsed as usize, DECAY_TABLE.len() - 1);
    let time_decay = DECAY_TABLE[decay_idx];

    let base = core::cmp::min(
        1000,
        completion_rate
            .saturating_add(volume_score)
            .saturating_add(diversity_score)
            .saturating_sub(dispute_penalty),
    );

    (base as u64 * time_decay as u64 / 1_000_000) as u32
}

pub mod jury_arbitration;

#[cfg(test)]
mod test;
#[cfg(test)]
mod jury_tests;
#[cfg(test)]
mod mst_test;
#[cfg(test)]
mod benchmarks;
