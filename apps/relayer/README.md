# @velo/relayer

Off-chain relayer that completes Stellar → EVM atomic swaps. It watches the
Soroban `atomic-swap` contract for `released` events, extracts the revealed
secret, and submits `withdraw(secret)` on the counterpart EVM HTLC.

## Layout

| File                     | Responsibility                                                                  |
| ------------------------ | ------------------------------------------------------------------------------- |
| `src/config.ts`          | Env config + fail-fast validation.                                              |
| `src/soroban-watcher.ts` | `decodeReleasedEvent` (pure) + `SorobanWatcher` polling `getEvents`.            |
| `src/evm-htlc.ts`        | `EvmHtlcClient` interface + ethers-backed implementation + ABI.                 |
| `src/relayer.ts`         | Orchestrator: on a `released` event, claim the EVM leg (idempotent per secret). |
| `src/index.ts`           | Entrypoint: wires config → watcher → EVM client → relayer.                      |

## Run

```bash
cp .env.example .env   # fill in the Soroban contract id and EVM_* values
npm run build
npm start
```

## Test

```bash
npm test    # unit tests, no network required
```

## Design notes

- **Polling, not streaming.** Soroban RPC `getEvents` is pull-based with a
  ledger cursor; polling gives free gap-recovery on restart. See
  [docs/relayer-architecture.md](../../docs/relayer-architecture.md) for the
  build-vs-integrate analysis behind this service.
- **Same secret, both legs.** The Soroban and EVM legs both hash-lock on
  `sha256(secret)`, so the relayer only needs to carry the revealed secret.
- **Idempotent.** Claims are de-duplicated per secret so an overlapping poll
  window never submits a second `withdraw`.

Full end-to-end walkthrough: [docs/cross-chain-relayer.md](../../docs/cross-chain-relayer.md).
