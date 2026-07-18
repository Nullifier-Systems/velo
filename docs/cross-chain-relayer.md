# Cross-Chain Relayer — Demo Walkthrough

This document shows one end-to-end Stellar → EVM atomic swap: a secret revealed
on the Soroban `atomic-swap` contract is picked up by the relayer and used to
claim the counterpart HTLC on an EVM testnet (Sepolia in this example).

- Soroban leg: [`contracts/atomic-swap`](../contracts/atomic-swap) (implements `htlc-core::Htlc`)
- EVM leg: [`contracts-evm/HTLC.sol`](../contracts-evm/HTLC.sol)
- Relayer: [`apps/relayer`](../apps/relayer)

## Why this works: one secret, two chains

Both legs hash-lock on the **same** function, `sha256(secret)`:

- Soroban `release(id, secret)` checks `sha256(secret) == secret_hash`, pays the
  seller, and **emits the secret** in a `released` event.
- EVM `withdraw(secret)` checks `sha256(secret) == hashlock` and pays the
  recipient.

The relayer watches Soroban `released` events, extracts the revealed secret, and
submits `withdraw(secret)` on the EVM HTLC. Because the EVM contract locates the
swap by `sha256(secret)`, the secret is the only payload that has to cross.

```
Buyer                Soroban atomic-swap            Relayer                 EVM HTLC (Sepolia)
  |  lock(id,H,...)  --------->|                       |                          |
  |                            |   (counterparty newSwap(H,...) funds EVM leg) -->|
  |  release(id,secret) ------>|                       |                          |
  |                            |-- released{secret} -->|                          |
  |                            |                       |-- withdraw(secret) ----->|
  |                            |                       |         (pays recipient) |
```

## Prerequisites

- Stellar testnet account with XLM + a test token, and the deployed
  `atomic-swap` contract id.
- Sepolia account with test ETH, and `HTLC.sol` deployed (see
  [contracts-evm/README.md](../contracts-evm/README.md)).
- Node 20+, and the Soroban/Stellar CLI for the contract calls.

## Step 1 — Deploy the two HTLC legs

Soroban (testnet):

```bash
cd contracts
cargo build --workspace --target wasm32-unknown-unknown --release
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/atomic_swap.wasm \
  --source <YOUR_KEY> --network testnet
# -> CONTRACT_ID; then initialize(admin, token):
stellar contract invoke --id <CONTRACT_ID> --source <YOUR_KEY> --network testnet \
  -- initialize --admin <ADMIN_G...> --token <TOKEN_C...>
```

EVM (Sepolia): deploy `contracts-evm/HTLC.sol` (Foundry/Remix — see its README),
note the address.

## Step 2 — Generate the shared secret + hashlock

```bash
node -e '
const {randomBytes, createHash} = require("crypto");
const s = randomBytes(32);
const h = createHash("sha256").update(s).digest();
console.log("secret  0x"+s.toString("hex"));
console.log("hashlock 0x"+h.toString("hex"));
'
```

The `hashlock` goes into both legs; the `secret` is revealed only at release.

## Step 3 — Fund both legs against the same hashlock

- EVM (counterparty locks funds for the buyer's EVM address):

```bash
cast send <EVM_HTLC_ADDRESS> \
  "newSwap(bytes32,address,uint256)" <HASHLOCK> <BUYER_EVM_ADDR> <UNIX_TIMELOCK> \
  --value 0.01ether --rpc-url $EVM_RPC_URL --private-key <COUNTERPARTY_EVM_KEY>
```

- Soroban (buyer locks the Stellar leg):

```bash
stellar contract invoke --id <CONTRACT_ID> --source <BUYER_KEY> --network testnet \
  -- lock --id <TRADE_ID_32B_HEX> --seller <SELLER_G...> --buyer <BUYER_G...> \
     --amount 5000000 --secret_hash <HASHLOCK> --timeout_ledgers 2000
```

## Step 4 — Start the relayer

```bash
cd apps/relayer
cp .env.example .env      # fill RELAYER_SOROBAN_CONTRACT_ID, EVM_* values
npm run build && npm start
# [relayer] started; watching Soroban released events
```

## Step 5 — Reveal the secret on Soroban

```bash
stellar contract invoke --id <CONTRACT_ID> --source <SELLER_KEY> --network testnet \
  -- release --id <TRADE_ID_32B_HEX> --secret <SECRET>
```

This pays the seller on Stellar and emits `released{ id, secret }`.

## Step 6 — Relayer claims the EVM leg automatically

Within one poll interval the relayer logs:

```
[relayer] claiming EVM leg for trade <id> (ledger <n>)
[relayer] claimed trade <id> -> EVM tx 0x<hash>
```

Verify on Sepolia that `withdraw(secret)` paid the recipient and emitted
`Withdrawn(hashlock, secret)`. That is one complete cross-chain claim: the
buyer's counterparty received the EVM funds using the secret the buyer revealed
on Stellar, with no trusted custodian in between.

## What is covered by automated tests vs. a live run

The relayer's logic is unit-tested without any network
([`apps/relayer/src/*.test.ts`](../apps/relayer/src)):

- `decodeReleasedEvent` extracts the exact trade id and secret from a synthetic
  Soroban event (both parsed-ScVal and raw base64-XDR shapes).
- `SorobanWatcher.pollOnce` fetches, decodes, and advances the ledger cursor.
- `Relayer.handleReleased` submits `withdraw(secret)`, is idempotent per secret
  (no double-claim on re-delivered events), and retries after a failed claim.

The contract leg is covered by Rust tests in
[`contracts/atomic-swap/src/test.rs`](../contracts/atomic-swap/src/test.rs),
including an assertion that `release()` reveals the secret in an event.

A live testnet run (Steps 1–6) requires funded Stellar + Sepolia accounts and
deployed contracts on both chains; the commands above are the exact reproducible
procedure. The relayer code path exercised in Step 6 is the same one the unit
tests drive.
