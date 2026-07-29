use escrow_fuzz_lib::differential;
use std::env;
use std::process;

fn main() {
    let iterations: usize = env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(10_000);

    eprintln!(
        "Running arithmetic overflow fuzzer: {} iterations",
        iterations
    );

    let mut failures = 0u64;

    // -----------------------------------------------------------------------
    // Fee arithmetic fuzzing
    // -----------------------------------------------------------------------
    eprintln!("  Phase 1: Fee arithmetic...");
    for i in 0..iterations {
        let seed = i as u64;
        let amount = generate_amount(seed);
        let fee_bps = generate_fee_bps(seed);

        // Test release fee arithmetic
        if let Err(e) = fuzz_release_fee(amount, fee_bps) {
            failures += 1;
            eprintln!("FAILURE (release fee) at {}: {}", i, e);
        }

        // Test dispute split arithmetic
        let buyer_share = generate_buyer_share(seed);
        if let Err(e) = fuzz_dispute_split(amount, buyer_share, fee_bps) {
            failures += 1;
            eprintln!("FAILURE (dispute split) at {}: {}", i, e);
        }
    }

    // -----------------------------------------------------------------------
    // Boundary value fuzzing
    // -----------------------------------------------------------------------
    eprintln!("  Phase 2: Boundary values...");
    let boundaries = [
        0i128,
        1,
        -1,
        i128::MAX,
        i128::MIN,
        i128::MAX / 10_000,
        i128::MAX / 10_000 + 1,
        10_000,
        10_001,
        100_000,
        1_000_000,
        1_000_000_000_000,
    ];

    let fee_bps_values = [0u32, 1, 50, 100, 1_000, 5_000, 9_999, 10_000, 10_001];

    for &amount in &boundaries {
        for &fee_bps in &fee_bps_values {
            if let Err(e) = fuzz_release_fee(amount, fee_bps) {
                failures += 1;
                eprintln!("FAILURE (boundary release fee): amount={} fee_bps={} - {}", amount, fee_bps, e);
            }

            for &buyer_share in &[0u32, 5_000, 10_000] {
                if let Err(e) = fuzz_dispute_split(amount, buyer_share, fee_bps) {
                    failures += 1;
                    eprintln!("FAILURE (boundary split): amount={} buyer={} fee={} - {}",
                        amount, buyer_share, fee_bps, e);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Overflow-specific tests
    // -----------------------------------------------------------------------
    eprintln!("  Phase 3: Overflow edge cases...");
    let overflow_cases = [
        (i128::MAX, 10_000u32),
        (i128::MAX, 1u32),
        (i128::MAX, 5_000u32),
        (i64::MAX as i128, 10_000u32),
        (i128::MAX / 10_000, 10_000u32),
        (i128::MAX / 10_000 + 1, 10_000u32),
        (1, 10_000u32),
        (10_000, 10_000u32),
    ];

    for (amount, fee_bps) in overflow_cases {
        // The contract guards: amount > i128::MAX / 10_000 => InvalidAmount
        // So if amount <= i128::MAX / 10_000, the fee calculation must not overflow
        if amount <= i128::MAX / 10_000 {
            if let Err(e) = fuzz_release_fee(amount, fee_bps) {
                failures += 1;
                eprintln!("FAILURE (overflow edge): amount={} fee_bps={} - {}", amount, fee_bps, e);
            }
        }

        // Multiplication overflow check: amount * fee_bps
        let product = (amount as i128).checked_mul(fee_bps as i128);
        if product.is_none() && amount <= i128::MAX / 10_000 {
            // This should never happen if the guard is correct
            failures += 1;
            eprintln!(
                "CRITICAL: multiplication overflow despite valid guard: amount={} fee_bps={}",
                amount, fee_bps
            );
        }
    }

    // -----------------------------------------------------------------------
    // Reference machine arithmetic (using fuzz_loop)
    // -----------------------------------------------------------------------
    eprintln!("  Phase 4: Reference machine arithmetic...");
    if let Err(e) = differential::fuzz_fee_arithmetic(iterations / 4) {
        failures += 1;
        eprintln!("FAILURE (fee fuzz_loop): {}", e);
    }
    if let Err(e) = differential::fuzz_split_arithmetic(iterations / 4) {
        failures += 1;
        eprintln!("FAILURE (split fuzz_loop): {}", e);
    }

    eprintln!(
        "Arithmetic overflow fuzz complete: {} failures out of {} iterations",
        failures, iterations
    );

    if failures > 0 {
        process::exit(1);
    }
}

fn fuzz_release_fee(amount: i128, fee_bps: u32) -> Result<(), String> {
    if fee_bps > 10_000 {
        return Ok(()); // Contract rejects this
    }
    if amount < 0 || amount > i128::MAX / 10_000 {
        return Ok(()); // Contract rejects this
    }

    let fee = (amount * fee_bps as i128) / 10_000;
    let payout = amount - fee;

    if fee < 0 {
        return Err(format!("negative fee: {}", fee));
    }
    if payout < 0 {
        return Err(format!("negative payout: {}", payout));
    }
    if fee + payout != amount {
        return Err(format!("fee({}) + payout({}) != amount({})", fee, payout, amount));
    }

    // Rounding property: fee should never exceed the ideal value
    if fee * 10_000 > amount * fee_bps as i128 {
        return Err(format!(
            "rounding violated: fee*10000={}) > amount*bps={}",
            fee * 10_000,
            amount * fee_bps as i128
        ));
    }

    Ok(())
}

fn fuzz_dispute_split(
    amount: i128,
    buyer_share_bps: u32,
    fee_bps: u32,
) -> Result<(), String> {
    if buyer_share_bps > 10_000 || fee_bps > 10_000 {
        return Ok(()); // Contract rejects these
    }
    if amount < 0 || amount > i128::MAX / 10_000 {
        return Ok(()); // Contract rejects these
    }

    let buyer_amount = (amount * buyer_share_bps as i128) / 10_000;
    let seller_gross = amount - buyer_amount;
    let fee = (seller_gross * fee_bps as i128) / 10_000;
    let seller_payout = seller_gross - fee;

    if buyer_amount < 0 {
        return Err(format!("negative buyer_amount: {}", buyer_amount));
    }
    if seller_gross < 0 {
        return Err(format!("negative seller_gross: {}", seller_gross));
    }
    if fee < 0 {
        return Err(format!("negative dispute fee: {}", fee));
    }
    if seller_payout < 0 {
        return Err(format!("negative seller_payout: {}", seller_payout));
    }
    if buyer_amount + seller_payout + fee != amount {
        return Err(format!(
            "split accounting: buyer({}) + seller({}) + fee({}) != amount({})",
            buyer_amount, seller_payout, fee, amount
        ));
    }

    Ok(())
}

fn generate_amount(seed: u64) -> i128 {
    let raw = (seed.wrapping_mul(0x9E3779B97F4A7C15) >> 16) as i128;
    (raw.abs() % 1_000_000) + 1
}

fn generate_fee_bps(seed: u64) -> u32 {
    ((seed.wrapping_mul(0x517CC1B727220A95) >> 32) % 10_001) as u32
}

fn generate_buyer_share(seed: u64) -> u32 {
    ((seed.wrapping_mul(0x6C62272E07BB31A2) >> 32) % 10_001) as u32
}
