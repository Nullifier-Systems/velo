# Mainnet Deployment Guide

This document covers everything required to deploy Velo to Stellar Mainnet.
Follow the checklist **in order** — each step depends on the previous one.

---

## Pre-launch Checklist

### 1. Smart Contract Audit & Verification

- [ ] **Escrow contract** — verified build matches committed source at
      `contracts/escrow/src/lib.rs` (run `cargo build --target wasm32-unknown-unknown --release`
      from `contracts/` and compare the WASM hash).
- [ ] **Atomic-swap contract** — same verification for `contracts/atomic-swap/src/lib.rs`.
- [ ] Third-party security audit completed for both escrow and atomic-swap.
- [ ] No `unwrap()` or `panic!()` that could be reachable via malformed input
      (outside the intentional `panic_with_error` guards).

### 2. Fee Economics — Final Review

| Parameter                          | Testnet       | Mainnet                            | Rationale                                                           |
| ---------------------------------- | ------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `platform_fee_bps` (escrow)        | 0 (not set)   | **50 bps (0.5%)**                  | Covers API hosting + x402 Stellar tx fees                           |
| `DEFAULT_TIMEOUT_LEDGERS`          | 100 (~15 min) | **500 (~50 min)**                  | Mainnet ledgers are ~5-6s; 500 ledgers gives ~50 min for a hand-off |
| `x402: GET /cash/agents`           | 0.001 USDC    | **0.005 USDC**                     | Covers Soroban simulation + submission cost                         |
| `x402: POST /cash/request`         | 0.01 USDC     | **0.05 USDC**                      | Covers escrow lock tx fee + profit margin                           |
| `x402: POST /cash/request/prepare` | 0.01 USDC     | **0.02 USDC**                      | Covers soroban simulation cost                                      |
| `x402: POST /cash/request/submit`  | 0.01 USDC     | **0.02 USDC**                      | Covers tx submission + verification cost                            |
| `x402: GET /reputation/:addr`      | 0.0005 USDC   | **0.002 USDC**                     | Covers lookup cost                                                  |
| Rate limit (global)                | 100 req/min   | **200 req/min**                    | Higher capacity for mainnet traffic                                 |
| Stellar BASE_FEE                   | 100 stroops   | **1000 stroops (min recommended)** | Mainnet requires higher fee for timely inclusion                    |

The escrow contract's `platform_fee_bps` is passed to `initialize()` at deployment
time and cannot be changed after initialization (the contract has no setter).
Choose carefully.

**USDC on Stellar Mainnet:**

- Issuer: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (Circle)
- SAC address: `CCW67TSZV3SSWZ6NAU4B46GSAV4IX3ODU6OVU5Q2ZWCEO6PJ6W7JXK2O`
- All settlement amounts in the escrow contract use this token.

### 3. Environment Configuration

Create `.env` in each service directory with mainnet values:

**apps/api/.env:**

```
PORT=3000
STELLAR_NETWORK=PUBLIC
SOROBAN_RPC_URL=https://soroban.stellar.org
MERCHANT_ADDRESS=G...MAINNET_MERCHANT_ADDRESS
ESCROW_CONTRACT_ID=C...DEPLOYED_ESCROW_CONTRACT_ID
# ⚠️  Leave BUYER_SECRET_KEY empty on mainnet — the API will reject it.
BUYER_SECRET_KEY=
FRONTEND_BASE_URL=https://app.velo.cash
ADMIN_API_KEY=<generated: openssl rand -hex 32>
REFUND_WEBHOOK_URL=<discord/slack webhook URL>
```

**apps/relayer/.env:**

```
STELLAR_NETWORK=PUBLIC
SOROBAN_RPC_URL=https://soroban.stellar.org
RELAYER_SOROBAN_CONTRACT_ID=C...DEPLOYED_ATOMIC_SWAP_CONTRACT_ID
RELAYER_POLL_INTERVAL_MS=2000
EVM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
EVM_PRIVATE_KEY=0x... (dedicated gas-only account)
EVM_HTLC_ADDRESS=0x...DEPLOYED_HTLC_CONTRACT
```

### 4. Contract Deployment (Order Matters)

```bash
# From repository root
cd contracts

# 1. Build release WASM for both contracts
cargo build --target wasm32-unknown-unknown --release

# 2. Deploy escrow contract
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/escrow.wasm \
  --rpc-url https://soroban.stellar.org \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --source <deployer-key>
# → Record the returned C... contract ID

# 3. Initialize escrow contract with USDC token and platform fee
soroban contract invoke \
  --id <escrow-contract-id> \
  --rpc-url https://soroban.stellar.org \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --source <admin-key> \
  -- \
  initialize \
  --admin <admin-address> \
  --token CCW67TSZV3SSWZ6NAU4B46GSAV4IX3ODU6OVU5Q2ZWCEO6PJ6W7JXK2O \
  --platform_fee_bps 50

# 4. Deploy atomic-swap contract
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/atomic_swap.wasm \
  --rpc-url https://soroban.stellar.org \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --source <deployer-key>
# → Record the returned C... contract ID

# 5. Initialize atomic-swap contract
soroban contract invoke \
  --id <atomic-swap-contract-id> \
  --rpc-url https://soroban.stellar.org \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --source <admin-key> \
  -- \
  initialize \
  --admin <admin-address> \
  --token CCW67TSZV3SSWZ6NAU4B46GSAV4IX3ODU6OVU5Q2ZWCEO6PJ6W7JXK2O
```

- [ ] Record deployed contract IDs in `packages/shared/src/index.ts` (`CONTRACTS.mainnet`)
- [ ] Update `apps/api/.env` with the escrow contract ID
- [ ] Update `apps/relayer/.env` with the atomic-swap contract ID

### 5. API Service Deployment

- [ ] Node.js 20+ runtime confirmed on target host
- [ ] All dependencies installed: `npm ci --production`
- [ ] Build: `npm run build -w apps/api`
- [ ] Smoke test: `curl http://localhost:3000/health` returns `{"ok":true}`
- [ ] Reverse proxy (nginx / Caddy) configured with TLS termination
- [ ] Rate limiting verified against global + per-route config
- [ ] CORS origin locked to `https://app.velo.cash`
- [ ] `ADMIN_API_KEY` set to a cryptographically random value
- [ ] `REFUND_WEBHOOK_URL` set to ops channel

### 6. Frontend Deployment

- [ ] `VITE_API_BASE_URL=https://api.velo.cash`
- [ ] `VITE_WS_URL=wss://api.velo.cash`
- [ ] Build: `npm run build -w mobile/frontend`
- [ ] Static assets deployed to CDN / S3 / Cloudflare Pages
- [ ] Custom domain `app.velo.cash` with TLS
- [ ] All API proxy routes point to mainnet backend

### 7. Security Verification

- [ ] **No custodial key on mainnet** — `BUYER_SECRET_KEY` is empty.
      Verify `loadSignerKeypair()` in `apps/api/src/lib/stellar.ts` throws
      with a clear error if someone accidentally sets it when `STELLAR_NETWORK=PUBLIC`.
- [ ] **x402 replay protection** — `usedPayments` set prevents double-use of
      a transaction hash. Verify it's bounded (Map of strings, size is unbounded
      in current implementation — add TTL eviction for production).
- [ ] **Rate limiting** — IP-based 200 req/min global, tighter per-route limits.
- [ ] **Admin endpoints** — gated by `x-admin-api-key` header, not by cookie/session.
- [ ] **CORS** — locked to the known frontend origin, not `*`.
- [ ] **No secrets in responses** — `secretHex` is always stripped (tested in
      `cash.test.ts` line 110: `expect(getBody).not.toHaveProperty("secretHex")`).
- [ ] **Soroban RPC** — uses HTTPS (`allowHttp: false` on mainnet by default,
      checked via `RPC_URL.startsWith("http://")`).
- [ ] **WebSocket chat** — gated per-trade by participant check against buyer/seller.
      Chat auto-closes when trade is released/refunded.

### 8. Non-Custodial Flow Verification (Mainnet Only)

The mainnet flow is:

```
1. Client calls POST /cash/request/prepare  (x402 paid)
   → API returns unsigned XDR + trade_id

2. Client signs the XDR with their own Stellar keypair
   → Submits to Stellar network

3. Client calls POST /cash/request/submit    (x402 paid)
   with signed_xdr + trade parameters
   → API verifies the submitted tx, registers trade
```

- [ ] `/prepare` correctly simulates the lock tx without requiring BUYER_SECRET_KEY
- [ ] `/submit` correctly submits a pre-signed envelope and confirms it
- [ ] Fallback: old `POST /cash/request` with `signed_xdr` field works too
- [ ] Test that the old custodial path (`POST /cash/request` without `signed_xdr`)
      is rejected on mainnet by `loadSignerKeypair()` throwing

### 9. Rollback Plan

If a critical issue is found post-launch:

| Severity                                 | Action                                                                                                                                                      | Timeline  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **Critical** (funds at risk)             | Pause the API (return 503). No on-chain action needed — funds are in the escrow contract and timeout-protected.                                             | Immediate |
| **High** (broken flow, no funds at risk) | Revert API deployment to last known-good version. Fix in staging, re-deploy.                                                                                | < 4 hours |
| **Medium** (non-functional issue)        | File an issue, fix in next release cycle.                                                                                                                   | < 1 week  |
| **Contract bug**                         | No on-chain fix possible (contracts are immutable). New version must be deployed and the old contract's remaining trades must timeout and refund naturally. | 1-2 weeks |

**Specific rollback scenarios:**

1. **Broken `/prepare` endpoint**: Clients can fall back to building the lock tx
   themselves using the Soroban SDK and calling `/submit` directly with the
   signed envelope. The `/submit` endpoint only verifies the tx was confirmed.

2. **Broken `/release` endpoint**: Since the escrow contract's `release()` function
   has no `require_auth()`, any party with the secret can build, sign, and submit
   the release tx independently using the Soroban SDK. The API is not a bottleneck.

3. **Broken `/refund` endpoint**: The contract's `refund()` is permissionless after
   timeout. Anyone can submit the refund. The API is not a bottleneck.

4. **Relayer failure**: Cross-chain claims pause. Funds on the Soroban side are
   safe — they timeout and are refundable. The EVM leg can be claimed manually
   by the admin key if needed.

### 10. Post-Launch Monitoring

- [ ] API health check (every 30s): `GET /health` → `{"ok":true}`
- [ ] Trade completion rate: `(released / locked) > 80%`
- [ ] x402 payment verification success rate
- [ ] WebSocket chat connections per trade
- [ ] Refund rate (spikes indicate UX issues)
- [ ] Relayer claim latency (Soroban release → EVM withdraw)
- [ ] Alert if `usedPayments` set grows beyond 100,000 entries

### 11. Go / No-Go Decision

All boxes above must be checked before mainnet launch. The final sign-off
requires:

- [ ] Smart contract audit passed (or waiver signed for unaudited deployment)
- [ ] Staging environment fully tested with mainnet-like conditions
- [ ] At least one end-to-end dry run on testnet using the non-custodial flow
- [ ] Ops team has access to admin endpoints + refund webhook
- [ ] Monitoring dashboards live and alerting configured

---

## Quick Reference

### Mainnet RPC Endpoints

| Service                    | URL                                                        |
| -------------------------- | ---------------------------------------------------------- |
| Soroban RPC                | `https://soroban.stellar.org`                              |
| Stellar Network Passphrase | `Public Global Stellar Network ; September 2015`           |
| USDC Issuer (Circle)       | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| USDC SAC                   | `CCW67TSZV3SSWZ6NAU4B46GSAV4IX3ODU6OVU5Q2ZWCEO6PJ6W7JXK2O` |

### Key Files to Update After Deployment

| File                           | What to Change                                                             |
| ------------------------------ | -------------------------------------------------------------------------- |
| `packages/shared/src/index.ts` | `CONTRACTS.mainnet.escrow` and `CONTRACTS.mainnet.atomicSwapA`             |
| `apps/api/.env`                | `ESCROW_CONTRACT_ID`, `SOROBAN_RPC_URL`, `STELLAR_NETWORK=PUBLIC`          |
| `apps/relayer/.env`            | `RELAYER_SOROBAN_CONTRACT_ID`, `SOROBAN_RPC_URL`, `STELLAR_NETWORK=PUBLIC` |
| `mobile/backend/.env`          | N/A (not used in mainnet flow yet)                                         |
| `apps/api/src/openapi.ts`      | Update server URL if different from `https://api.velo.cash`                |

### Useful Commands

```bash
# Deploy escrow contract
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/escrow.wasm \
  --rpc-url https://soroban.stellar.org \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --source <deployer-secret>

# Initialize escrow
soroban -config-dir .soroban/config \
  contract invoke \
  --id <CONTRACT_ID> \
  --rpc-url https://soroban.stellar.org \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --source <admin-secret> \
  -- \
  initialize \
  --admin <admin-address> \
  --token CCW67TSZV3SSWZ6NAU4B46GSAV4IX3ODU6OVU5Q2ZWCEO6PJ6W7JXK2O \
  --platform_fee_bps 50

# Query contract version / state
soroban contract invoke \
  --id <CONTRACT_ID> \
  --rpc-url https://soroban.stellar.org \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --source <any-key> \
  -- \
  get_trade \
  --id <32-byte-hex-trade-id>
```
