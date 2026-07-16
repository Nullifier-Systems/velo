# Protocol Upgrade Resilience Policy

To prevent repeat incidents of chain-side changes breaking Velo's Soroban contracts (such as the Protocol 27/CAP-71 XDR decoding break and the ed25519-dalek bug), the team must adopt a proactive SDK and protocol version management strategy.

## 1. Version Pinning Policy
- **Strict Pinning**: All core dependencies, including the `stellar-sdk`, `soroban-sdk`, and test utilities, must be strictly pinned in `package.json` and `Cargo.toml`. Avoid using broad ranges (`^` or `~`).
- **Controlled Upgrades**: Version bumps must be treated as significant architectural changes. Upgrades should be done deliberately in a dedicated PR, tested thoroughly against both the current and the upcoming protocol versions.

## 2. Upgrade-Testing Cadence
- **Testnet Monitoring**: Automated integration tests must run nightly against the Stellar Testnet and Futurenet. This ensures we detect breaking changes introduced by upcoming protocol upgrades before they reach Mainnet.
- **Dual-Version Testing**: When a protocol upgrade is announced, CI pipelines must be configured to run our test suite against both the current Mainnet release and the release candidate (RC) versions of the Stellar Core/Soroban RPC.

## 3. Monitoring and Communication
- **Upstream Tracking**: An assigned engineer must subscribe to Stellar Developer mailing lists, Soroban Discord announcements, and GitHub releases for core tools.
- **Pre-emptive Action**: Any upcoming protocol changes (CAPs) that affect XDR structures, authentication, or SDK behavior must have an issue created in the Velo repository at least 3 weeks before the Testnet upgrade date.
