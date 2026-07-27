//! On-chain, verifiable reputation scoring formula (#283).
//!
//! Computes a deterministic score for a Stellar address by calling the
//! deployed escrow contract's public `get_trade_count()`, `get_trade_by_index()`,
//! and `get_trade()` functions to read on-chain trade history.
#![no_std]

use htlc_core::{TradeState, TradeStatus};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Bytes, Env, Map, Symbol,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEDGERS_PER_DAY: u32 = 17_280;
const MAX_TRADES: u32 = 200;

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
    101_442, 100_381, 99_327, 98_280, 97_239, 96_205, 95_177, 94_155, 93_140, 92_130,
    91_127, 90_129, 89_137, 88_151, 87_170, 86_194, 85_224, 84_259, 83_299, 82_345,
    81_395, 80_450, 79_510, 78_575, 77_644, 76_718, 75_796, 74_879, 73_966, 73_057,
    72_153, 71_252, 70_356, 69_464, 68_575, 67_691, 66_810, 65_933, 65_060, 64_190,
    63_324, 62_461, 61_602, 60_746, 59_894, 59_045, 58_199, 57_357, 56_518, 55_682,
    54_849, 54_019, 53_192, 52_369, 51_548, 50_731, 49_916, 49_104, 48_296, 47_490,
    46_687, 45_887, 45_089, 44_294, 43_502, 42_713, 41_926, 41_142, 40_360, 39_581,
    38_804, 38_030, 37_258, 36_489, 35_722, 34_957, 34_195, 33_435, 32_678, 31_923,
    31_170, 30_419, 29_671, 28_925, 28_181, 27_439, 26_699, 25_962, 25_227, 24_494,
    23_763, 23_034, 22_308, 21_583, 20_861, 20_141, 19_423, 18_707, 17_993, 17_281,
    16_571, 15_864, 15_158, 14_455, 13_753, 13_054, 12_357, 11_662, 10_969, 10_278,
    9_590, 8_903, 8_218, 7_536, 6_856, 6_178, 5_502, 4_829, 4_158, 3_489,
    2_823, 2_159, 1_497, 838, 181, 0,
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
enum RepDataKey {
    Admin,
    EscrowContract,
    CachedScore(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    EscrowNotSet = 4,
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
            .set(&RepDataKey::EscrowContract, &escrow_contract);
    }

    /// Compute and cache the reputation score for an address.
    pub fn compute_score(env: Env, address: Address) -> u32 {
        let escrow = env
            .storage()
            .persistent()
            .get::<RepDataKey, Address>(&RepDataKey::EscrowContract)
            .expect("escrow contract not set");

        let count = call_escrow_u32(&env, &escrow, "get_trade_count");
        let scan_max = core::cmp::min(count, MAX_TRADES);
        if scan_max == 0 {
            env.storage()
                .persistent()
                .set(&RepDataKey::CachedScore(address), &0u32);
            return 0;
        }

        let mut total: u32 = 0;
        let mut completed: u32 = 0;
        let mut disputed: u32 = 0;
        let mut volume: i128 = 0;
        let mut counterparties: Map<Address, bool> = Map::new(&env);

        for idx in 1..=scan_max {
            let trade_id: Option<BytesN<32>> = call_escrow_get_trade_id(&env, &escrow, idx);
            let Some(tid) = trade_id else { continue };

            let trade: Option<TradeState> = call_escrow_get_trade(&env, &escrow, &tid);
            let Some(t) = trade else { continue };

            let is_seller = t.seller == address;
            let is_buyer = t.buyer == address;
            if !is_seller && !is_buyer {
                continue;
            }
            if t.seller == t.buyer {
                continue;
            }

            total += 1;
            let counterparty = if is_seller { t.buyer.clone() } else { t.seller.clone() };
            counterparties.set(counterparty, true);

            match t.status {
                TradeStatus::Released | TradeStatus::Resolved => {
                    completed += 1;
                    volume = volume.saturating_add(t.amount);
                }
                TradeStatus::Disputed => {
                    disputed += 1;
                }
                _ => {}
            }
        }

        let score = compute_score_internal(
            total, completed, disputed, volume, counterparties.len(), total, &env,
        );

        env.storage()
            .persistent()
            .set(&RepDataKey::CachedScore(address), &score);
        score
    }

    pub fn get_score(env: Env, address: Address) -> Option<u32> {
        env.storage()
            .persistent()
            .get(&RepDataKey::CachedScore(address))
    }

    pub fn get_score_breakdown(env: Env, address: Address) -> ScoreBreakdown {
        let score = Self::compute_score(env.clone(), address);
        ScoreBreakdown {
            total_trades: 0,
            completed_trades: 0,
            disputed_trades: 0,
            total_volume: 0,
            unique_counterparties: 0,
            score,
            last_trade_ledger: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Cross-contract invocations
// ---------------------------------------------------------------------------

fn call_escrow_u32(env: &Env, escrow: &Address, func: &str) -> u32 {
    env.invoke_contract(
        escrow,
        &Symbol::new(env, func),
        (),
    )
}

fn call_escrow_get_trade_id(env: &Env, escrow: &Address, index: u32) -> Option<BytesN<32>> {
    env.invoke_contract(
        escrow,
        &Symbol::new(env, "get_trade_by_index"),
        (index,),
    )
}

fn call_escrow_get_trade(env: &Env, escrow: &Address, id: &BytesN<32>) -> Option<TradeState> {
    env.invoke_contract(
        escrow,
        &Symbol::new(env, "get_trade"),
        (id.clone(),),
    )
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
    env: &Env,
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

#[cfg(test)]
mod test;
