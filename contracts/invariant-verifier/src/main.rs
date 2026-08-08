mod checker;
mod spec;

use checker::InvariantChecker;
use spec::InvariantSpec;
use std::env;
use std::path::PathBuf;
use std::process::exit;

fn main() -> Result<(), anyhow::Error> {
    let args: Vec<String> = env::args().collect();
    let mut spec_path = PathBuf::from("specifications/htlc_escrow_invariants.json");

    let mut i = 1;
    while i < args.len() {
        if args[i] == "--spec" && i + 1 < args.len() {
            spec_path = PathBuf::from(&args[i + 1]);
            i += 2;
        } else {
            i += 1;
        }
    }

    if !spec_path.exists() {
        // Fallback relative check if run from contracts/ directory or workspace root
        if PathBuf::from("contracts").join(&spec_path).exists() {
            spec_path = PathBuf::from("contracts").join(&spec_path);
        } else if PathBuf::from("../specifications/htlc_escrow_invariants.json").exists() {
            spec_path = PathBuf::from("../specifications/htlc_escrow_invariants.json");
        }
    }

    println!("=======================================================");
    println!(" Soroban Formal Invariant Verification Framework       ");
    println!("=======================================================");
    println!("Loading specification from: {}", spec_path.display());

    let spec = InvariantSpec::load_from_file(&spec_path).map_err(|e| {
        anyhow::anyhow!(
            "Failed to parse invariant spec file {}: {}",
            spec_path.display(),
            e
        )
    })?;

    println!("Target Contract : {}", spec.contract_name);
    println!("Spec Version    : {}", spec.version);
    println!("Description     : {}", spec.description);
    println!("Invariants      : {}", spec.invariants.len());
    println!("-------------------------------------------------------");

    let checker = InvariantChecker::new(spec.clone());
    let results = checker.verify_all();

    let mut passed_count = 0;
    let mut failed_count = 0;

    for res in &results {
        if res.passed {
            passed_count += 1;
            println!("  [PASS] {} - {}", res.invariant_id, res.name);
        } else {
            failed_count += 1;
            println!("  [FAIL] {} - {}", res.invariant_id, res.name);
            if let Some(err) = &res.error_message {
                println!("         Detail: {}", err);
            }
        }
    }

    println!("-------------------------------------------------------");
    println!(
        "Verification Summary: {} Passed, {} Failed",
        passed_count, failed_count
    );
    println!("=======================================================");

    if failed_count > 0 {
        eprintln!("CRITICAL: Invariant verification failed!");
        exit(1);
    } else {
        println!("SUCCESS: All formal invariants preserved.");
        Ok(())
    }
}
