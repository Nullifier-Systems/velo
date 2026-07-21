# npm Audit Vulnerability Triage

## Overview

Per issue #53, this document contains the triage analysis of 10 npm audit vulnerabilities found in the `Nullifier-Systems/velo` monorepo as of 2026-07-17.

---

## Applied Fixes

| Package    | Old Version | New Version | Type                              | Status                                                                    |
| ---------- | ----------- | ----------- | --------------------------------- | ------------------------------------------------------------------------- |
| `fast-uri` | 2.4.0       | 2.4.1       | Patch (safe, via `npm audit fix`) | ⚠️ Still within vulnerable range (≤3.1.1) — vulnerability count unchanged |

**Note:** `fast-uri@2.4.1` remains within the vulnerable range (≤3.1.1). A full fix requires upgrading to `fast-uri@>=3.2.0`, which requires the `fastify` ecosystem to upgrade to v5 (breaking change).

The vulnerability count remained at **10** after `npm audit fix` because the patch did not exit the vulnerable range.

---

## Remaining Vulnerabilities — Risk Assessment

### Runtime Dependencies (Real Risk)

These packages are used in production and represent genuine risk:

| Package                                   | Severity | GHSA ID                                                           | Workspace                    | Description                                                                                           | Fix Available                   |
| ----------------------------------------- | -------- | ----------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------- |
| **fastify**                               | High     | `GHSA-mrq3-vjjr-p77c` `GHSA-jx2c-rxcm-jvmq` `GHSA-444r-cwp2-x5xf` | `@velo/api`, `@velo/backend` | DoS via unbounded memory allocation, body validation bypass via tab character, protocol/host spoofing | `fastify@5.x` (breaking)        |
| **fast-uri**                              | High     | `GHSA-q3j6-qgpj-74h6` `GHSA-v39h-62p7-jpjc`                       | (fastify transitive dep)     | Path traversal via percent-encoded dot segments, host confusion via percent-encoded delimiters        | `>=3.2.0` (requires fastify v5) |
| **@fastify/ajv-compiler**                 | High     | _(via fast-uri)_                                                  | (fastify transitive dep)     | Affected by `fast-uri` vulnerability                                                                  | Requires fastify v5             |
| **fast-json-stringify**                   | High     | _(via fast-uri)_                                                  | (fastify transitive dep)     | Affected by `fast-uri` vulnerability                                                                  | Requires fastify v5             |
| **@fastify/fast-json-stringify-compiler** | High     | _(via fast-json-stringify)_                                       | (fastify transitive dep)     | Affected by `fast-json-stringify` vulnerability                                                       | Requires fastify v5             |

### Development-Only Dependencies (Low Production Risk)

These packages are only used during development, building, and testing. They are **not exposed** in production environments:

| Package            | Severity | GHSA ID                                                           | Workspace                    | Description                                                                       | Risk Rationale                                                  |
| ------------------ | -------- | ----------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **vitest**         | Critical | `GHSA-5xrq-8626-4rwp`                                             | `@velo/api`, `@velo/relayer` | Arbitrary file read/execution via Vitest UI server                                | **Low** — Vitest UI server not used; only run in CI/development |
| **vite**           | High     | `GHSA-4w7w-66w2-5vf9` `GHSA-v6wh-96g9-6wx3` `GHSA-fx2h-pf6j-xcff` | `@velo/frontend`             | Path traversal in optimized deps, NTLMv2 hash disclosure, `server.fs.deny` bypass | **Low** — Dev/build tool only, not exposed in production        |
| **esbuild**        | Moderate | `GHSA-67mh-4wv8-2f99`                                             | (vite/vitest transitive dep) | Enables websites to send requests to dev server                                   | **Low** — Build-time only                                       |
| **vite-node**      | Moderate | _(via vite)_                                                      | (vitest transitive dep)      | Affected by `vite` vulnerability                                                  | **Low** — Dev-only                                              |
| **@vitest/mocker** | Moderate | _(via vite)_                                                      | (vitest transitive dep)      | Affected by `vite` vulnerability                                                  | **Low** — Dev-only                                              |

---

## Breaking Changes Requiring Follow-Up

The following fixes require **major version upgrades** and cannot be safely auto-fixed with `npm audit fix`:

### 1. Fastify v4 → v5 Migration

**Affected workspaces:** `@velo/api`, `@velo/backend`
**Vulnerabilities resolved:** 5 (all high-severity runtime vulns)
**Scope:**

- Update `fastify` from `^4.28.0` to `^5.x` in `apps/api/package.json` and `mobile/backend/package.json`
- Update `@fastify/cors` from `^9.0.1` to compatible version
- Update `@fastify/rate-limit` from `^9.1.0` to compatible version
- Audit all route registration and hook APIs for v5 breaking changes
- See: [Fastify V5 Migration Guide](https://github.com/fastify/fastify/blob/main/docs/Migration-Guide-V5.md)

### 2. Vite v5 → v6/v8 + Vitest v2 → v3 Migration

**Affected workspaces:** `@velo/frontend` (vite), `@velo/api` + `@velo/relayer` (vitest)
**Vulnerabilities resolved:** 5 (1 critical, 3 high, 2 moderate — but all dev-only)
**Scope:**

- Update `vite` from `^5.4.0` to `^6.x` (or `^8.x`) in `mobile/frontend/package.json`
- Update `@vitejs/plugin-react` to compatible version
- Update `vitest` from `^2.0.5` to `^3.x` in `apps/api/package.json` and `apps/relayer/package.json`
- Check Vite migration guides for breaking changes

---

## Summary

- **1 safe fix applied** — `fast-uri` 2.4.0 → 2.4.1 (patch update, still within vulnerable range)
- **Vulnerability count unchanged** at 10 after the patch (patch did not exit the vulnerable version range)
- **5 runtime vulnerabilities** remain in the `fastify` ecosystem — these require a Fastify v4→v5 migration
- **5 dev-only vulnerabilities** remain in `vite`/`vitest` — low production risk, require a Vite + Vitest major version upgrade
- All **23 tests pass** after the safe fix
