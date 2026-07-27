#!/usr/bin/env bash
set -euo pipefail
set +x

readonly RPC_URL="${STELLAR_TESTNET_RPC_URL:-https://soroban-testnet.stellar.org}"
readonly HORIZON_URL="${STELLAR_TESTNET_HORIZON_URL:-https://horizon-testnet.stellar.org}"
readonly MIN_BALANCE_XLM="${STELLAR_TESTNET_MIN_BALANCE_XLM:-10}"
readonly REGISTRY="packages/shared/src/index.ts"
readonly CONFIG_DIR="$(mktemp -d)"

cleanup() {
  rm -rf -- "$CONFIG_DIR"
}
trap cleanup EXIT

fail() {
  echo "::error::$1" >&2
  exit 1
}

if [[ -z "${STELLAR_TESTNET_DEPLOYER_SECRET:-}" ]]; then
  fail "STELLAR_TESTNET_DEPLOYER_SECRET is not configured."
fi

# Import into an ephemeral CLI config so the secret is never passed to deploy
# commands or written to the repository. Command tracing remains disabled.
CLEANED_SECRET="$(tr -d '\r\n' <<<"$STELLAR_TESTNET_DEPLOYER_SECRET")"
printf '%s' "$CLEANED_SECRET" |
  stellar keys add ci-deployer --secret-key --config-dir "$CONFIG_DIR" >/dev/null 2>&1 ||
  fail "The configured testnet deployer key is invalid."
unset STELLAR_TESTNET_DEPLOYER_SECRET CLEANED_SECRET

deployer_address="$(stellar keys public-key ci-deployer --config-dir "$CONFIG_DIR")" ||
  fail "Could not derive the deployer account address."

stellar network health --rpc-url "$RPC_URL" \
  --network-passphrase "Test SDF Network ; September 2015" \
  --config-dir "$CONFIG_DIR" >/dev/null ||
  fail "Testnet RPC is unavailable. No address records were changed."

account_json="$(curl --fail --silent --show-error --retry 3 --retry-all-errors \
  --connect-timeout 10 --max-time 30 "$HORIZON_URL/accounts/$deployer_address")" ||
  fail "Could not query the deployer balance. No address records were changed."
if command -v jq >/dev/null 2>&1; then
  native_balance="$(jq -er '.balances[] | select(.asset_type == "native") | .balance' <<<"$account_json")" ||
    fail "The deployer account has no native XLM balance."
else
  native_balance="$(node -e 'const data=JSON.parse(process.argv[1]); const b=data.balances?.find(x=>x.asset_type==="native"); if(!b){process.exit(1);} console.log(b.balance);' "$account_json")" ||
    fail "The deployer account has no native XLM balance."
fi
awk -v balance="$native_balance" -v minimum="$MIN_BALANCE_XLM" \
  'BEGIN { exit !(balance + 0 >= minimum + 0) }' ||
  fail "Insufficient deployer balance: at least $MIN_BALANCE_XLM XLM is required."

deploy_contract() {
  local wasm="$1"
  local label="$2"
  local output

  output="$(stellar contract deploy --quiet \
    --wasm "$wasm" \
    --source-account ci-deployer \
    --network testnet \
    --network-passphrase "Test SDF Network ; September 2015" \
    --rpc-url "$RPC_URL" \
    --config-dir "$CONFIG_DIR")" ||
    fail "$label deployment failed. No address records were changed."

  output="$(grep -oE 'C[A-Z2-7]{55}' <<<"$output" | tail -n1)"
  [[ -n "$output" ]] ||
    fail "$label deployment returned an invalid contract address."
  printf '%s' "$output"
}

readonly ESCROW_WASM="contracts/target/wasm32v1-none/release/escrow.wasm"
readonly ATOMIC_SWAP_WASM="contracts/target/wasm32v1-none/release/atomic_swap.wasm"
[[ -f "$ESCROW_WASM" && -f "$ATOMIC_SWAP_WASM" ]] ||
  fail "Release WASM artifacts are missing; build the contracts before deployment."

escrow_address="$(deploy_contract "$ESCROW_WASM" "Escrow")"
atomic_swap_address="$(deploy_contract "$ATOMIC_SWAP_WASM" "Atomic swap")"

# The updater validates both IDs and writes via a sibling temporary file before
# replacing the registry, so a failed update cannot truncate the prior record.
node scripts/update-testnet-contract-addresses.mjs \
  "$escrow_address" "$atomic_swap_address" "$REGISTRY"

echo "Recorded testnet escrow contract: $escrow_address"
echo "Recorded testnet atomic swap contract: $atomic_swap_address"
