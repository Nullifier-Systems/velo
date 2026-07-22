#!/usr/bin/env bash
# Run Soroban-specific static analysis on all contracts.
# Intended for CI: exits 0 if no errors found, 1 if errors found.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Soroban Static Analysis ==="

# Build + run the linter against all contract source files
cargo run -p soroban-lint -- \
  escrow/src/lib.rs \
  atomic-swap/src/lib.rs \
  htlc-core/src/lib.rs

echo "=== Analysis complete ==="
