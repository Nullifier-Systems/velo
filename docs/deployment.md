# Deployment Guide

Velo is currently structured for local development and staged deployment rather than a single monolithic production rollout.

## Environment Configuration

Use environment files for local development and configure deployment-specific values in the hosting platform.

## Contract Deployment

Soroban contract deployment should be handled carefully and recorded in the shared contract registry. The contract addresses should be centralized in the shared package rather than duplicated across the repository.

Merges to `main` that change `contracts/**` run `.github/workflows/testnet-contract-deploy.yml`. Configure `STELLAR_TESTNET_DEPLOYER_SECRET` as a GitHub Actions secret on the protected `testnet` environment. The dedicated account should contain at least 10 testnet XLM. The workflow builds and deploys both Soroban contracts, then atomically updates `CONTRACTS.testnet` in `packages/shared/src/index.ts` and commits the addresses to `main`.

The deployment script checks RPC availability and account balance before submitting transactions. Any missing key, insufficient balance, RPC failure, failed deployment, or invalid returned address exits before replacing the registry. For local failure testing, run `bash scripts/deploy-testnet-contracts.sh` with the secret unset, with `STELLAR_TESTNET_RPC_URL` set to an unreachable URL, and with an unfunded testnet key; in each case, verify that `git diff -- packages/shared/src/index.ts` remains empty. A live deployment still requires the protected GitHub environment and funded deployer account.

## Service Deployment

The API and mobile backend services should be deployed with explicit environment configuration and monitoring. The current repository expects environment variables for ports, merchant settings, and network configuration.

### WebSocket chat

Multi-instance chat requires a managed Redis service reachable through `REDIS_URL`. All API instances must share that Redis database and the same `CHAT_CAPABILITY_SECRET` (minimum 32 characters). Redis holds trade membership, ciphertext history, encryption public keys, sequence IDs, and Pub/Sub channels; do not use the no-Redis development fallback in serverless production.

The hosting platform must support WebSocket upgrades and connection lifetimes long enough for chat. Deployments may interrupt sockets, so clients automatically reconnect and request messages after their last received ID. Keep `CHAT_CAPABILITY_TTL_SECONDS` long enough for the expected locked-trade session and rotate `CHAT_CAPABILITY_SECRET` as a coordinated deployment because rotation invalidates outstanding capabilities.

## Release Checklist

- verify contract build output,
- update the shared contract registry,
- run tests,
- confirm environment variables,
- review logs and failover behavior before launch.
