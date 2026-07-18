# Changelog

All notable changes to Velo will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

---

## Changelog Conventions

Future entries in this changelog should adhere to the following rules:

- **Group changes by type**: Use the following subheadings under each release/milestone:
  - `Added` for new features.
  - `Changed` for changes in existing functionality.
  - `Deprecated` for soon-to-be-removed features.
  - `Removed` for now-removed features.
  - `Fixed` for any bug fixes.
  - `Security` in case of vulnerabilities.
- **Reference pull requests**: Include the PR number (e.g., `#12`) at the end of each entry when applicable.
- **Keep it human-readable**: Focus on the impact of the change rather than commit-by-commit developer details.
- **Update with PRs**: Contributors are encouraged to update this file under the `## Unreleased` section as part of their pull request.

---

## Unreleased

### Added

- `atomic-swap` contract now fully implements the `htlc-core::Htlc` trait (lock/release/refund); `release()` reveals the secret in an event for the cross-chain relayer, with a full Rust test suite (#12).
- `apps/relayer`: Off-chain relayer that watches Soroban `released` events and claims the counterpart HTLC on an EVM chain, with unit tests and a demo walkthrough (#12).
- `contracts-evm/HTLC.sol`: SHA-256-hashlocked EVM counterpart HTLC (#12).
- Proposed persistence schema and migrations for cash requests, Bazaar intents, and reputation (#24).
- Relayer architecture comparison (custom vs LayerZero/Wormhole/Axelar) with a recommendation (#25).
- Expanded contributor-facing documentation.
- Production-oriented repository overview and architecture guidance.
- Security, conduct, and governance policies.

### Changed

- Rewrote the main README to better explain the project’s purpose and structure.

---

## Major Milestones

### API Launch - 2026-07-10

#### Added
- Initialized the Fastify API with X402 payment gate middleware.
- Configured Vercel serverless function entry points for backend/API hosting.
- Set up CORS support for frontend API interactions.

### Frontend Launch - 2026-07-10

#### Added
- Initialized the mobile web frontend with a claim ticket and QR code display page.
- Created key utility functions (`formatStroops`, `shortAddress`) with matching unit tests.

### Contract Deployment - 2026-07-09

#### Added
- Initialized and deployed the core Escrow Smart Contracts.
- Recorded deployed escrow contract addresses on the Stellar Testnet.
- Added Stellar SDK, cryptography, and store helpers for escrow contract interactions.
