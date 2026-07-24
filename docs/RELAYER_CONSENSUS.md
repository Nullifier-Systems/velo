# Byzantine-Fault-Tolerant Relayer Network — Design Specification

## Overview

This specification details the architecture and consensus model for Velo's Byzantine-fault-tolerant (BFT) relayer network. The cross-chain HTLC mechanism transfers value between Stellar/Soroban and EVM chains using a shared secret preimage (`sha256(secret) == hashlock`).

While secret relaying is inherently trustless (a secret cannot steal funds or alter the designated recipient), relying on a single relayer instance introduces a single point of failure: one operator can censor or delay claim submissions until the HTLC timelock expires.

To resolve this liveness vulnerability without introducing complex, heavyweight consensus engines (such as Tendermint or PBFT), Velo implements an $M$-of-$N$ **threshold-attestation quorum** on the destination EVM HTLC contract.

---

## 1. Relayer Consensus Mechanism

Relayers operate as independent, decoupled observer nodes:

1. **Independent Observation**: Each relayer instance independently monitors Soroban ledger events via RPC (`SorobanWatcher`) for contract `released{tradeId, secret}` events.
2. **Attestation Submission**: Upon detecting a valid `released` event, each relayer node independently submits an on-chain attestation (`submitAttestation(bytes32 secret)`) to the EVM HTLC contract.
3. **On-Chain Quorum Aggregation**: The EVM HTLC smart contract serves as the deterministic state machine. It collects attestations per swap (`hashlock`), verifies that each attestation originates from an authorized relayer, and tracks unique attestations.
4. **Automatic Execution**: Once $M$ distinct authorized relayers have attested to the secret for a given swap, the contract automatically executes the claim, transferring the locked funds to the predefined recipient.

---

## 2. Smart Contract Integration

The EVM HTLC contract (`contracts-evm/HTLC.sol`) extends the single-relayer `withdraw` function with threshold governance:

- **Relayer Registry**: Maintains an allowlist of authorized relayer addresses (`mapping(address => bool) isRelayer`) and a threshold count `threshold` ($M$).
- **Attestation Tracking**:
  - `mapping(bytes32 => mapping(address => bool)) hasAttested`
  - `mapping(bytes32 => uint256) attestationCount`
- **Function Interface**:
  - `submitAttestation(bytes32 secret)`: Validates relayer identity, prevents duplicate attestations from the same node, increments `attestationCount`, and triggers payout when `attestationCount[hashlock] >= threshold`.
  - `withdraw(bytes32 secret)`: Retained as a fallback/alias for single-relayer or un-permissioned deployment modes (`threshold == 0`).

---

## 3. Targeted Fault Threshold & Parameterization

The relayer network targets a standard Byzantine fault model:

- **Total Relayers ($N$)**: The number of registered, authorized relayer operators.
- **Max Faulty Relayers ($f$)**: The maximum number of relayers that may be offline, non-responsive, or actively malicious.
- **Quorum Threshold ($M$)**: Defined as $M = N - f$.

### Default Configuration ($N = 3, M = 2, f = 1$)
- **Fault Tolerance**: Up to $f = 1$ faulty or malicious relayer can be tolerated out of $N = 3$.
- **Liveness Guarantee**: Any $M = 2$ honest, active relayers are sufficient to process claims promptly.
- **Safety Guarantee**: A single rogue relayer ($1 < M$) cannot unilaterally trigger or block a claim.

---

## 4. Economic Incentives & Operator Economics

To ensure long-term honest operation and discourage neutral-cost malicious behavior, the relayer network employs an economic incentive structure:

1. **Relayer Fee Rewards**:
   - Swaps include a protocol relayer fee split among relayers that successfully submit valid attestations within the quorum window.
2. **Stake Slashing & Governance**:
   - Relayers must register an authorized address and post collateral/stake (or undergo allowlist governance).
   - Submitting invalid attestations (e.g. invalid preimages, corrupted trade IDs) or failing liveness SLAs results in stake slashing and removal from the authorized set (`isRelayer = false`).
3. **Preventing Zero-Cost Attacks**:
   - Submitting on-chain transactions incurs EVM gas costs. Malicious relayers attempting to spam false attestations burn gas without receiving rewards, creating a direct financial penalty for malicious activity.

---

## 5. Security Boundaries & Non-Goals

This threshold-attestation design explicitly defines its security boundaries:

- **Collusion Exceeding $f$**: If $> f$ relayers collude or go offline simultaneously, claim submission will stall until the HTLC timelock elapses, allowing swap senders to refund.
- **Sybil Vulnerability without Staking/Allowlist**: The threshold mechanism relies on an explicit set of authorized relayer addresses. Without an on-chain allowlist or staking registry, an attacker could Sybil the network by creating multiple relayer identities.
- **Fund Security Guarantee**: Funds in `HTLC.sol` are bound to `s.recipient` at swap creation. Even if malicious relayers reach quorum on a secret, funds can only ever flow to the legitimate swap recipient.
