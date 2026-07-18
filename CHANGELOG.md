# Changelog

All notable changes to Velo will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## How to Add Entries

### Format

Each entry should follow this format:

```markdown
### Added/Changed/Deprecated/Removed/Fixed/Security

- Description of the change (#issue-number)
```

### Categories

- **Added** for new features.
- **Changed** for changes in existing functionality.
- **Deprecated** for soon-to-be removed features.
- **Removed** for now removed features.
- **Fixed** for any bug fixes.
- **Security** in case of vulnerabilities.

### Guidelines

1. **Date format**: Use `YYYY-MM-DD` format for dates.
2. **Version format**: Use `## [version]` for released versions, `## [Unreleased]` for work in progress.
3. **Issue references**: Always reference related issues using `(#issue-number)` format.
4. **Grouping**: Group related changes under the same category heading.
5. **Tone**: Keep descriptions concise and user-focused, not developer-focused.

### Example

```markdown
## [0.2.0] - 2026-07-16

### Added

- Provider dashboard for earnings and trades (#17)
- Merchant discovery with proximity-based matching (#29)
- Admin monitoring and manual refund overrides (#39)

### Fixed

- Payment verification issues (#19)
```

---

## [Unreleased]

### Added

- `atomic-swap` contract now fully implements the `htlc-core::Htlc` trait
  (lock/release/refund); `release()` reveals the secret in an event for the
  cross-chain relayer, with a full Rust test suite (#12),
- `apps/relayer`: off-chain relayer that watches Soroban `released` events and
  claims the counterpart HTLC on an EVM chain, with unit tests and a demo
  walkthrough (#12),
- `contracts-evm/HTLC.sol`: SHA-256-hashlocked EVM counterpart HTLC (#12),
- proposed persistence schema + migration for cash requests, Bazaar intents,
  and reputation (#24),
- relayer architecture comparison (custom vs LayerZero/Wormhole/Axelar) with a
  recommendation (#25),
- expanded contributor-facing documentation,
- production-oriented repository overview and architecture guidance,
- security, conduct, and governance policies.

### Changed

- rewrote the main README to better explain the project's purpose and structure.

---

## [0.1.0] - 2026-07-17

### Added

- Admin dashboard for monitoring and managing platform operations (#39)
- QR payload persistence alongside cash request records (#118)
- Unit tests for frontend utility functions (#113)
- API schema validation for cash requests (#109)
- Escrow contract address documentation (#107)
- Webhook notifications for refunds (#106)
- Merchant discovery with bounding-box matching (#29)
- Lightweight API key authentication (#104)
- Refund endpoint and webhook support (#106)
- Low-cost bounding-box matching for `/cash/agents` endpoint (#105)
- Admin monitoring, trade flagging, and manual refund overrides (#39)
- OpenAPI 3.1 specification at `/api/v1/openapi.json` (#73)
- Provider dashboard for earnings and trades (#17)
- Provider registration and proximity-based discovery (#18)
- Payment verification tests (#19)
- Rate limiting to all API endpoints (#46)
- ErrorBoundary component for frontend routes (#65)
- Skeleton loading state for claims (#1)
- Local setup documentation (#56)
- Atomic-swap HTLC + cross-chain relayer with research (#27)

### Fixed

- npm audit vulnerabilities (#53)
- Cash request body validation (#109)
- LICENSE consistency (#99)

---

## [0.0.2] - 2026-07-13

### Added

- On-chain payment verification (#14)
- Escrow contract deployed on testnet (#11)
- SPA routing for client-side routes on Vercel (#10)
- Shared package main entry point (#9)
- CORS support for frontend API calls (#8)
- ClaimQR ticket-stub page (#6)
- API client for cash requests (#5)
- Serverless entry point for Vercel deployment (#4)

### Fixed

- stellar-sdk upgrade to v16 with mainnet guard (#11)
- Secret generation moved to client side (#11)
- Vercel configuration for serverless deployment (#8)
- ed25519-dalek compilation error (#11)

### Changed

- Moved to modern vercel.json configuration (#8)

---

## [0.0.1] - 2026-07-10

### Added

- Initial project scaffold with contracts, API, frontend, and backend
- Fastify API with X402 payment gate middleware
- Mobile web frontend with claim QR display page
- Vercel serverless deployment configuration
- Stellar SDK integration for escrow contract calls
- Basic cash routes with lock/release functionality
