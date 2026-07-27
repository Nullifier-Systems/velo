use anyhow::Result;
use std::path::Path;
use walkdir::WalkDir;

mod checks;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!(
            "soroban-lint — Soroban-specific static analysis tool\n\
             \n\
             Usage: soroban-lint <path> [path ...]\n\
             \n\
             Detects Soroban-specific bugs in Rust smart contracts:\n\
               • Missing require_auth() on Address parameters\n\
               • Missing extend_ttl() after persistent storage writes\n\
               • CEI (Checks-Effects-Interactions) pattern violations\n\
             \n\
             Example: soroban-lint contracts/escrow/src/ contracts/atomic-swap/src/"
        );
        std::process::exit(1);
    }

    let mut total_warnings = 0u64;
    let mut total_errors = 0u64;

    for path in &args[1..] {
        let p = Path::new(path);
        if p.is_dir() {
            for entry in WalkDir::new(p) {
                let entry = entry?;
                let file_path = entry.path();
                if file_path.extension().map_or(true, |ext| ext != "rs") {
                    continue;
                }
                let (w, e) = analyze_file(file_path)?;
                total_warnings += w;
                total_errors += e;
            }
        } else if p.extension().map_or(false, |ext| ext == "rs") {
            let (w, e) = analyze_file(p)?;
            total_warnings += w;
            total_errors += e;
        } else {
            eprintln!("Warning: skipping non-Rust file: {}", p.display());
        }
    }

    println!();
    println!("═══════════════════════════════════════");
    println!("  Scan complete");
    println!("  Warnings: {}", total_warnings);
    println!("  Errors:   {}", total_errors);
    println!("═══════════════════════════════════════");

    if total_errors > 0 {
        std::process::exit(1);
    }

    Ok(())
}

fn analyze_file(file_path: &Path) -> Result<(u64, u64)> {
    let source = match std::fs::read_to_string(file_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{}: error reading file: {}", file_path.display(), e);
            return Ok((0, 0));
        }
    };

    let ast = match syn::parse_file(&source) {
        Ok(ast) => ast,
        Err(e) => {
            eprintln!("{}: parse error: {}", file_path.display(), e);
            return Ok((0, 1));
        }
    };

    println!("\n── {} ──", file_path.display());

    let mut warning_count = 0u64;
    let mut error_count = 0u64;

    // Check 1: Missing require_auth() on Address parameters
    let (w, e) = checks::require_auth::check(&ast, file_path);
    warning_count += w;
    error_count += e;

    // Check 2: Missing extend_ttl() after persistent storage writes
    let (w, e) = checks::storage_ttl::check(&ast, file_path);
    warning_count += w;
    error_count += e;

    // Check 3: CEI (Checks-Effects-Interactions) pattern violations
    let (w, e) = checks::cei_pattern::check(&ast, file_path);
    warning_count += w;
    error_count += e;

    if warning_count == 0 && error_count == 0 {
        println!("  ✓ No issues found");
    }

    Ok((warning_count, error_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_source(source: &str) -> syn::File {
        syn::parse_file(source).expect("failed to parse test source")
    }

    // ── require_auth tests ──

    #[test]
    fn test_require_auth_missing() {
        let source = r#"
use soroban_sdk::{Address, Env};
pub fn do_thing(env: Env, caller: Address, recipient: Address) {
    let _x = 1;
}
"#;
        let ast = parse_source(source);
        let path = Path::new("test.rs");
        let (w, _) = checks::require_auth::check(&ast, path);
        assert_eq!(w, 1, "should warn: Address params without require_auth");
    }

    #[test]
    fn test_require_auth_present() {
        let source = r#"
use soroban_sdk::{Address, Env};
pub fn do_thing(env: Env, caller: Address) {
    caller.require_auth();
}
"#;
        let ast = parse_source(source);
        let path = Path::new("test.rs");
        let (w, _) = checks::require_auth::check(&ast, path);
        assert_eq!(w, 0, "should not warn: require_auth is called on caller");
    }

    #[test]
    fn test_require_auth_skips_test_fns() {
        let source = r#"
use soroban_sdk::{Address, Env};
#[test]
pub fn test_thing(env: Env, caller: Address) {
    let _x = 1;
}
"#;
        let ast = parse_source(source);
        let path = Path::new("test.rs");
        let (w, _) = checks::require_auth::check(&ast, path);
        assert_eq!(w, 0, "should skip #[test] functions");
    }

    // ── storage_ttl tests ──

    #[test]
    fn test_storage_ttl_missing() {
        let source = r#"
use soroban_sdk::Env;
pub fn do_write(env: Env) {
    let key = 1u32;
    env.storage().persistent().set(&key, &42u32);
}
"#;
        let ast = parse_source(source);
        let path = Path::new("test.rs");
        let (w, _) = checks::storage_ttl::check(&ast, path);
        assert_eq!(w, 1, "should warn: set without extend_ttl");
    }

    #[test]
    fn test_storage_ttl_present() {
        let source = r#"
use soroban_sdk::Env;
pub fn do_write(env: Env) {
    let key = 1u32;
    env.storage().persistent().set(&key, &42u32);
    env.storage().persistent().extend_ttl(&key, 100, 100);
}
"#;
        let ast = parse_source(source);
        let path = Path::new("test.rs");
        let (w, _) = checks::storage_ttl::check(&ast, path);
        assert_eq!(w, 0, "should not warn: extend_ttl follows set");
    }

    // ── cei_pattern tests ──

    #[test]
    fn test_cei_violation() {
        let source = r#"
use soroban_sdk::Env;
pub fn do_stuff(env: Env, key: u32) {
    let state = 1u32;
    let addr = ();
    let amount = 1i128;
    let client = ();
    // The .transfer() call pattern is detected regardless of receiver name
    client.transfer(&addr, &addr, &amount);
    env.storage().persistent().set(&key, &state);
}
"#;
        let ast = parse_source(source);
        let path = Path::new("test.rs");
        let (w, _) = checks::cei_pattern::check(&ast, path);
        assert_eq!(w, 1, "should warn: storage set after transfer");
    }

    #[test]
    fn test_cei_ok() {
        let source = r#"
use soroban_sdk::Env;
pub fn do_stuff(env: Env, key: u32) {
    let state = 1u32;
    let addr = ();
    let amount = 1i128;
    let client = ();
    env.storage().persistent().set(&key, &state);
    client.transfer(&addr, &addr, &amount);
}
"#;
        let ast = parse_source(source);
        let path = Path::new("test.rs");
        let (w, _) = checks::cei_pattern::check(&ast, path);
        assert_eq!(w, 0, "should not warn: state updated before transfer");
    }
}
