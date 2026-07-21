# Cross-Chain Relayer — Architecture Options

Status: **research + recommendation** (issue #25). Feeds directly into the
relayer implementation in issue #12.

## The problem, precisely

`atomic-swap` (Stellar/Soroban) and a counterpart HTLC on another chain lock the
same funds against the same hashlock `sha256(secret)`. When the secret is
revealed on one leg, someone must carry it to the other leg and call
`withdraw(secret)`. We need to decide **how** that carry happens: build a custom
watcher, or integrate a general interoperability protocol (LayerZero, Wormhole,
Axelar).

The single most important property: **relaying a revealed HTLC secret is
trustless and mechanical.** The relayer cannot steal, forge, or redirect funds —
the secret either hashes to the hashlock or it does not, and funds always go to
the recipient the HTLC already fixed. If the relayer is offline, funds are not at
risk; the timelock refund makes the swap safe by default. The relayer provides
**liveness, not security.**

## Options

### A. Custom relayer (watch Soroban events → submit EVM `withdraw`)

Poll Soroban RPC `getEvents` for `released`, decode the secret, submit
`withdraw(secret)` on the EVM HTLC. This is what `apps/relayer` implements.

- **Trust model:** none added. Security is the HTLC's; the relayer is permissionless.
- **Cost:** just gas for the `withdraw` tx + a small always-on process.
- **Effort:** low — one event decoder + one contract call (already built and tested).
- **Chains:** anything with an RPC and a signer (Stellar RPC + any EVM here).

### B. Wormhole (Guardian-attested messaging)

Wormhole passes arbitrary messages attested by a Guardian validator set (VAAs).

- **Trust model:** the Guardian set — an external security assumption the HTLC
  does not otherwise need.
- **Cost/effort:** deploy/integrate emitter + receiver contracts, handle VAA
  relaying and fees.
- **Stellar/Soroban support:** nascent — **verify current status before relying on it.**

### C. Axelar (validator network + General Message Passing)

Axelar routes GMP calls through its validator network and gateway contracts;
Stellar integration has been announced.

- **Trust model:** Axelar's validator set + gateway contracts.
- **Cost/effort:** gateway/gas-service integration, relayer fees, contract changes
  on both legs to send/receive GMP calls.
- **Stellar/Soroban support:** emerging — **verify maturity/testnet coverage first.**

### D. LayerZero (oracle + relayer messaging)

LayerZero delivers messages via a configurable oracle + relayer (DVN) stack,
primarily across EVM chains.

- **Trust model:** the configured DVN/oracle-relayer set.
- **Cost/effort:** endpoint integration + per-message fees; OApp contract changes.
- **Stellar/Soroban support:** limited/absent as of writing — **verify.**

## Comparison

| Criterion                             | A. Custom            | B. Wormhole                  | C. Axelar           | D. LayerZero        |
| ------------------------------------- | -------------------- | ---------------------------- | ------------------- | ------------------- |
| Added trust assumption                | **None**             | Guardian set                 | Validator set       | DVN/oracle set      |
| Solves _our_ problem (secret relay)   | **Exactly**          | Overkill (general messaging) | Overkill            | Overkill            |
| Stellar/Soroban support               | Native (RPC)         | Nascent                      | Emerging            | Limited             |
| Integration effort                    | **Low**              | High                         | High                | High                |
| Ongoing cost                          | Gas + 1 process      | Gas + protocol fees          | Gas + protocol fees | Gas + protocol fees |
| Funds-at-risk if relayer/bridge fails | No (timelock refund) | Adds bridge risk             | Adds bridge risk    | Adds bridge risk    |
| Contract changes on both legs         | No                   | Yes                          | Yes                 | Yes                 |

## Recommendation

**Build the custom relayer (Option A).** For HTLC secret-relay it is the correct
tool: it adds no trust assumptions, requires no contract changes on either leg,
supports Stellar and any EVM chain today, and is cheap to run. The general
messaging bridges solve a _different_ problem — trust-minimized delivery of
arbitrary messages — and paying their trust, fee, and integration costs to move a
32-byte secret that is already self-verifying is unjustified. Worse, routing the
secret through a bridge would _reduce_ the swap's security from "trustless HTLC"
to "trust the bridge's validator set."

**Revisit this decision if** Velo needs generalized cross-chain state (not just
HTLC secret relay) across many heterogeneous chains, or wants to offer swaps
against chains where running a direct signer is impractical. At that point a
messaging protocol (most likely Axelar or Wormhole, given their Stellar
direction) becomes worth the added trust surface. Until then, keep the relayer
thin.

Operational hardening for the custom relayer (all liveness, not security):
persist the ledger cursor for restart-safe resume, run redundant instances
(claims are idempotent per secret — see `Relayer.handleReleased`), alert on claim
failures, and always rely on the HTLC timelock as the ultimate backstop.

## Recommended architecture (implemented in `apps/relayer`)

```
Soroban atomic-swap                 Relayer (apps/relayer)              EVM HTLC (contracts-evm)
  release(id, secret)                 SorobanWatcher.pollOnce()
     emits released{id, secret} --->  getEvents -> decodeReleasedEvent
                                       -> Relayer.handleReleased(secret)
                                       -> EvmHtlcClient.withdraw(secret) --->  withdraw(secret)
                                          (idempotent per secret)               pays recipient
```

- `SorobanWatcher` — polls `getEvents` (pull-based with a ledger cursor; polling
  gives free gap-recovery on restart — the reason we poll rather than stream).
- `decodeReleasedEvent` — pure, unit-tested extraction of `{ tradeId, secret }`.
- `Relayer` — idempotent orchestration; a re-delivered event never double-claims.
- `EvmHtlcClient` — thin ethers wrapper submitting `withdraw(secret)`.

See [docs/cross-chain-relayer.md](cross-chain-relayer.md) for the end-to-end demo.
