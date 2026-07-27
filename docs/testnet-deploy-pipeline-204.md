## Automated Testnet Deployment Pipeline — Architecture Proposal

### Trigger

Extend `contracts-ci.yml` with a new job, `deploy-testnet`, gated to `on: push: branches: [main], paths: ["contracts/**"]` — i.e. only runs after a PR touching contracts merges to `main`, never on PR branches themselves. This keeps forks/external contributors from ever triggering a deploy (GitHub Actions secrets aren't exposed to PRs from forks by default, but an explicit branch gate makes the intent unambiguous instead of relying on that default).

### Key Management — no static secret in GitHub

The current mainnet doc uses a raw `--source <deployer-key>` passed to the CLI. For CI, a long-lived secret key sitting in GitHub Secrets is the single biggest risk (repo compromise = deployer key compromise, and rotation requires re-provisioning). Recommendation:

- **Use a CI-scoped, low-value testnet key only** — never reuse a mainnet-capable key for CI. Fund it with a self-serve Friendbot top-up job (testnet XLM is free), so even a full leak has zero financial blast radius.
- **Store as a GitHub encrypted secret (`TESTNET_DEPLOYER_SECRET`)**, scoped to a GitHub Environment (`testnet-deploy`) with **required reviewer approval** — so even though the trigger is automatic on merge, the actual deploy step pauses for a human "approve" click before the secret is materialized into the job. This gives a manual gate without giving up push-to-deploy convenience for everything except the key-use moment.
- **Rotate on a schedule** (e.g. quarterly) via a separate manual workflow_dispatch job — rotation should never be blocked on remembering to do it ad hoc.
- Longer-term / stretch option: replace the static secret with a **short-lived signing flow** (CI requests a signature from a separate signer service holding the key, rather than CI holding the key directly) — worth flagging as a future hardening step, not a blocker for v1.

### Deployment Steps (CI job)

1. Build release WASM (already exists in `contracts-ci.yml`, reuse it).
2. Deploy via `soroban contract deploy` using the environment-scoped secret.
3. Initialize with **testnet-specific parameters** — pull `platform_fee_bps` and timeout values from a checked-in `testnet-params.json` rather than hardcoding in the workflow YAML, so parameter changes are reviewable in a normal PR diff.
4. Capture the returned contract ID from CLI stdout.

### Address Tracking — replace manual edits with a CI-committed update

Instead of a human manually editing `packages/shared/src/index.ts` after every deploy (today's process, and the actual defect surface — that `"SET_ME_AFTER_FIRST_DEPLOY"` string is a live bug waiting to happen):

- CI job writes the new contract ID directly into `CONTRACTS.testnet` in that file.
- Commits the change back to `main` **as the CI bot**, with a clear commit message (`chore(deploy): update testnet escrow address to C...`) — using `git-auto-commit-action` or equivalent, with `[skip ci]` in the message to avoid a redeploy loop.
- This makes every address change a visible, auditable commit in history rather than an untracked manual edit — closing the exact gap the current registry file demonstrates.

### Failure Handling

- **Build/test failure**: job stops before any deploy step runs — no partial state possible (existing `cargo test` gate already covers this).
- **Deploy step fails** (RPC timeout, insufficient testnet XLM, etc.): job fails loudly, no commit to the registry happens — `main` stays pointed at the last-known-good address, nothing silently breaks for downstream consumers of `CONTRACTS.testnet`.
- **Deploy succeeds but initialize fails**: this is the dangerous partial-state case — a live but uninitialized contract. Mitigate by treating deploy+initialize as a single atomic CI step (if initialize fails, the job should explicitly log the orphaned contract ID as a warning artifact for manual cleanup, rather than silently discarding it — testnet contracts are cheap to abandon, but the ID should still be visible for debugging).
- **Registry commit fails** (e.g. branch protection blocks bot pushes): fail the job explicitly rather than treating deploy-without-commit as success — an unrecorded testnet address is effectively a silent failure for anyone relying on the registry.
