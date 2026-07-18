# Contributing to Velo

Thank you for investing time in Velo. This document explains how to contribute in a way that is consistent with the project’s current architecture and long-term maintenance goals.

## Ways to Contribute

You can contribute by:

- improving documentation,
- fixing bugs,
- adding tests,
- refining contracts,
- improving developer experience,
- proposing architectural changes.

## Before You Start

1. Read this guide and the project README.
2. Review the relevant documentation in the docs/ directory.
3. Check whether there is already an issue or discussion for your topic.
4. Keep changes focused and isolated.

## Development Workflow

### 1. Fork and clone

```bash
git clone https://github.com/Nullifier-Systems/velo.git
cd velo
npm install
```

### 2. Create a feature branch

Use a descriptive branch name:

```bash
git checkout -b feat/escrow-release-flow
```

### 3. Make changes

Prefer small, reviewable commits. Keep contract and application changes clearly separated when possible.

### 4. Run validation

```bash
npm run build
npm run test
cd contracts && cargo test --workspace
```

### 5. Open a pull request

Before opening a PR:

- summarize the change clearly,
- link related issues,
- mention any security implications,
- ensure the diff is understandable to reviewers.

## Commit Convention

Use concise, descriptive commit messages. A good pattern is:

- `feat: add escrow refund flow`
- `fix: handle missing payment header`
- `docs: expand architecture guide`
- `refactor: simplify contract state handling`

## Branch Strategy

- `main` is the stable integration branch.
- feature branches should be short-lived and merged through pull requests.
- release branches should be used only when a coordinated release is required.

## Coding Standards

- prefer clear, explicit names over clever abstractions,
- keep logic localized and easy to test,
- document non-obvious behavior,
- avoid introducing hidden side effects,
- preserve the current modular structure.

## Dependency Updates

To prevent bugs from unpinned version drift, this project adheres to strict dependency management:

- **Pin dependencies**: All dependencies in `package.json`, `Cargo.toml`, and other manifests should be pinned to specific versions where possible.
- **Reviewing Dependabot PRs**: Dependabot is configured to propose updates. All Dependabot PRs must be actively reviewed. Reviewers should check the dependency's changelog for breaking changes and verify that all CI checks (tests, linting, formatting) pass before merging.
- **Commit lockfiles**: Ensure `package-lock.json`, `Cargo.lock` and any other lockfiles are always committed and up-to-date with your changes.

## Review Expectations

Pull requests should:

- be easy to review,
- include rationale,
- include tests or validation steps where appropriate,
- avoid unrelated churn.

## Community Expectations

We expect contributors to be respectful, constructive, and mindful of the project’s security posture. Harassment or disruptive behavior will not be tolerated.
