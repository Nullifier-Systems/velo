# Development Guide

This guide is the single, ordered walkthrough for setting up Velo locally from a fresh clone.

## 1. Prerequisites

Install the following first:

- Node.js 20+
- npm 10+
- Rust toolchain
- the Soroban CLI or Stellar CLI
- a funded Stellar testnet account

## 2. Clone and install workspace dependencies

```bash
git clone https://github.com/Nullifier-Systems/velo.git
cd velo
npm install
```

## 3. Install the Rust wasm target required by Soroban

The contracts need the wasm target installed before you build them:

```bash
rustup target add wasm32v1-none
```

> Windows note: if you are using PowerShell and the target install fails, reopen the terminal after Rust is installed and run the command again.

## 4. Install the Soroban CLI

If you do not already have the Soroban CLI installed, follow the official installation steps for your platform. The local workflow expects it to be available on your `PATH`.

Verify it is available:

```bash
soroban --version
```

## 5. Prepare a funded Stellar testnet account

You need a funded testnet account for the API to submit transactions. Create or fund one in the Stellar testnet network, then copy the public address and secret key into the environment files below.

## 6. Create the environment files

Copy the sample files and fill in the values:

```bash
cp apps/api/.env.example apps/api/.env
cp mobile/backend/.env.example mobile/backend/.env
```

Edit the created files and set at least:

- `apps/api/.env`
  - `MERCHANT_ADDRESS`
  - `BUYER_SECRET_KEY`
  - `STELLAR_NETWORK=TESTNET`
  - `SOROBAN_RPC_URL=https://soroban-testnet.stellar.org`
- `mobile/backend/.env`
  - `DATABASE_URL` (for local backend development)

## 7. Build and test the contracts

From the repository root, build the contracts workspace:

```bash
cd contracts
cargo build --workspace
cargo test --workspace
```

## 8. Start the local apps

From the repository root, start the workspace:

```bash
npm run dev
```

Or start the services individually:

```bash
npm run dev:api
npm run dev:frontend
npm run dev:backend
```

## 9. Windows-specific gotchas

The following issues have been observed on Windows and are worth handling explicitly:

- PowerShell quoting: when passing commands that include quotes, wrap them carefully. For example, prefer:

```powershell
"https://example.com"
```

instead of relying on shell-implicit quoting in mixed command lines.

- The Soroban wasm target is required: if you see errors about missing wasm support or target installation, run:

```powershell
rustup target add wasm32v1-none
```

- If `soroban` is not recognized, reopen PowerShell after installation or ensure the CLI binary is on your `PATH`.
