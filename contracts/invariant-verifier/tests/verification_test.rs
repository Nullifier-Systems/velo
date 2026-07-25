#[path = "../src/checker.rs"]
mod checker;
#[path = "../src/spec.rs"]
mod spec;

use checker::{InvariantChecker, VerificationResult};
use spec::{InvariantItem, InvariantSeverity, InvariantSpec};
use std::path::PathBuf;

fn load_test_spec() -> InvariantSpec {
    let path = PathBuf::from("specifications/htlc_escrow_invariants.json");
    let fallback = PathBuf::from("../specifications/htlc_escrow_invariants.json");
    if path.exists() {
        InvariantSpec::load_from_file(path).unwrap()
    } else if fallback.exists() {
        InvariantSpec::load_from_file(fallback).unwrap()
    } else {
        panic!("Specification file not found in test context");
    }
}

#[test]
fn test_framework_passes_on_correct_contract() {
    let spec = load_test_spec();
    let checker = InvariantChecker::new(spec);
    let results = checker.verify_all();

    assert_eq!(results.len(), 6, "Expected 6 invariants to be tested");
    for res in &results {
        assert!(
            res.passed,
            "Invariant {} ({}) failed unexpectedly: {:?}",
            res.invariant_id, res.name, res.error_message
        );
    }
}

#[test]
fn test_framework_catches_deliberate_invariant_violations() {
    // Construct a synthetic spec with a broken invariant check assertion to simulate contract mutation failure
    let mut spec = load_test_spec();
    
    // Replace expression with a failing specification expectation to test negative reporting
    spec.invariants.push(InvariantItem {
        id: "INV-MUTATED".into(),
        name: "Deliberate Mutation Violation".into(),
        category: "Synthetic Mutation Test".into(),
        description: "Simulates a broken contract upgrade violating state monotonicity".into(),
        expression: "false".into(),
        severity: InvariantSeverity::CRITICAL,
    });

    let checker = InvariantChecker::new(spec);
    let results = checker.verify_all();

    let mutated_result = results.iter().find(|r| r.invariant_id == "INV-MUTATED");
    assert!(
        mutated_result.is_some(),
        "Mutated invariant result should exist"
    );
    assert!(
        !mutated_result.unwrap().passed,
        "Mutated invariant should be flagged as failed"
    );
    assert!(
        mutated_result.unwrap().error_message.is_some(),
        "Mutated invariant must include diagnostic failure details"
    );
}
