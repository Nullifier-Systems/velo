# ZK Nullifier Claim Verification on Soroban ΓÇö Feasibility Spike

## Executive Summary

This spike evaluates whether Groth16 zero-knowledge proofs can be verified
inside a Soroban WASM smart contract for privacy-preserving escrow claims.
**Conclusion: On-chain Groth16 is infeasible on Soroban today.** The
recommended architecture is a hybrid: off-chain ZK proving (Noir +
Barretenberg) with an on-chain nullifier registry that enforces
double-spending via hash-based commitment checks, gated by an optional
off-chain oracle attestation for high-value claims.

---

## 1. Soroban WASM Resource Analysis

### Contract Size Limit

| Limit | Value | Implication for ark-groth16 |
|-------|-------|---------------------------|
| WASM binary | 100 KB | ark-ec + ark-ff + ark-poly + ark-serialize ΓåÆ 500 KB+ ΓÇö **blows limit** |
| WASM modules | 1 per tx | Cannot split verification across contracts |

Soroban v28 (future) may raise the limit, but no current timeline.

### CPU Instruction Budget

| Operation | Approx. Cost | Count Needed | Total |
|-----------|-------------|-------------|-------|
| BN254 pairing check (Miller loop) | 12ΓÇô18M | 3 (Groth16) | 36ΓÇô54M |
| Pippenger MSM (multi-exp) | 8ΓÇô12M | 1 | 8ΓÇô12M |
| SHA-256 (64 B) | 4k | 2 | 8k |
| Storage read/write | 20k | 2 | 40k |

The base budget is ~40M CPU ops (Soroban v27). A single pairing check
consumes nearly half. **Groth16 verification exceeds the default budget.**
Users could increase `soroban_invoke_contract` fees to raise the limit, but
typical RPC providers cap this.

### Memory

WASM linear memory starts at 64 pages (4 MB). BN254 scalar multiplication
tables need ~2ΓÇô3 MB. Combined with the proving key material, memory is tight.

### Crypto Primitives Available

| Primitive | Soroban HostFn |
|-----------|---------------|
| SHA-256 | `env.crypto().sha256()` |
| Keccak-256 | `env.crypto().keccak256()` |
| Ed25519 verify | `env.crypto().ed25519_verify()` |
| Secp256k1 ecdsa | `env.crypto().secp256k1_ecdsa_verify()` |
| **BN254 pairing** | **Not available** |
| **BLS12-381 pairing** | **Not available** |

**No elliptic-curve pairing precompile exists.** A custom WASM
implementation would add 200 KB+ to the binary and still need pairings
implemented in WASM, which is 10ΓÇô100├ù slower than native.

---

## 2. Nullifier Storage Schema

The existing `contracts/zk-credential` contract already implements a
gas-efficient nullifier registry. The pattern generalises to any claim flow:

```rust
#[contracttype]
pub enum DataKey {
    Nullifier(BytesN<32>),   // key   = nullifier_hash
                             // value = bool (spent)
}

// ΓöÇΓöÇ Record ΓöÇΓöÇ
env.storage().persistent().set(&DataKey::Nullifier(hash), &true);

// ΓöÇΓöÇ Check ΓöÇΓöÇ
if env.storage().persistent().has(&DataKey::Nullifier(hash)) {
    return Err(Error::NullifierAlreadySpent);
}
```

### Gas Efficiency

| Storage Type | Rent (per entry) | Expiry |
|-------------|-----------------|--------|
| `persistent()` | ~0.5 XLM / entry | Permanent (with rent) |
| `instance()` | ~1 XLM / contract | Contract lifetime |

For nullifiers, `persistent()` is the natural fit: each nullifier is a
32-byte key mapping to a `bool`. The footprint is minimal (~80 bytes per
nullifier), and the rent cost is paid by the claim initiator.

### Anti-Replay Guarantee

- **Binding**: Nullifier hash is `Poseidon(secret, domain_sep)` in Noir
  circuits, or `SHA256(secret || domain)` on-chain. Using the same domain
  on both sides guarantees consistency.
- **Finality**: Once `persistent().set()` commits, the nullifier is
  permanently spent. No expiry is needed for nullifier entries (unlike
  Merkle roots).

---

## 3. Architectural Comparison

| Criterion | On-Chain WASM | Off-Chain Oracle |
|-----------|--------------|------------------|
| **ZK proof verification** | Infeasible (pairing precompiles missing; budget blown) | Feasible (Barretenberg runs natively on verifier node) |
| **Proof size** | ~200 B (Groth16) ΓÇö fits | ~200 B (Groth16) ΓÇö fits in tx calldata |
| **Latency** | Immediate (~5 s finality) | ~1ΓÇô2 rounds (prover submits, oracle attestation settles) |
| **Trust model** | Trustless (Soroban consensus) | Trusted oracle set (threshold signature or attestation) |
| **Nullifier recording** | On-chain `persistent()` | On-chain `persistent()` (oracle attests and records) |
| **Upgradeability** | Hard (contract must be replaced) | Easy (oracle software updates) |
| **Cost per claim** | ~0.01 XLM (storage + invocation) | ~0.02 XLM (oracle fee + storage) |
| **Privacy level** | Full privacy (ZK proof verified, no wallet revealed) | Conditional privacy (oracle sees proof metadata unless encrypted) |

### Decision Matrix

| Use Case | Verdict | Rationale |
|----------|---------|-----------|
| Low-value private claims (< 100 USDC) | **On-chain hash commitment** | Don't need full ZK; SHA256(root \|\| nullifier) is sufficient to bind proof |
| Medium-value claims (100ΓÇô10k USDC) | **Off-chain ZK + on-chain nullifier** | Prove off-chain, record nullifier on-chain via oracle attestation |
| High-value claims (> 10k USDC) | **Off-chain ZK + oracle attestation + dispute period** | Full ZK proof verified by multiple oracles with slashing |
| Cross-chain claims (Stellar ΓåÆ EVM) | **Off-chain ZK + relayer** | Proof verified off-chain, relayer submits lightweight attestation |

---

## 4. Recommended Architecture

```
ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ     Groth16 proof      ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
Γöé   Claimant   Γöé ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓû╢ Γöé ZK Verifier   Γöé
Γöé  (Noir Prover)Γöé                        Γöé   Node        Γöé
ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ                        Γöé (Barretenberg)Γöé
                                         ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
                                                 Γöé
                                          attestation sig
                                                 Γöé
                                                 Γû╝
                                   ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
                                   Γöé  Soroban: Escrow Claim   Γöé
                                   Γöé  + Nullifier Registry    Γöé
                                   ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
```

### Key Components

1. **Claimant (Noir Prover)**: Generates Groth16 proof using Noir
   `credential_verifier` circuit. Submits `(root, nullifier_hash, proof)` to
   the ZK Verifier Node.

2. **ZK Verifier Node**: Runs Barretenberg to verify the Groth16 proof. On
   success, signs an attestation containing `(nullifier_hash, claim_id,
   timestamp)` with its Ed25519 key.

3. **Soroban Escrow Contract**: Receives the attestation, verifies the
   oracle's signature via `env.crypto().ed25519_verify()`, checks the
   nullifier hasn't been spent, records it, and releases funds.

### Why This Works Within Soroban Limits

| Constraint | How We Stay Within It |
|-----------|----------------------|
| 100 KB WASM | Ed25519 verify + SHA-256 + storage ΓÇö under 40 KB binary |
| 40M CPU budget | Ed25519 verify (~200k) + SHA-256 (~4k) + storage (~20k) ΓÇö under 1M total |
| No pairing precompile | Pairings happen off-chain in Barretenberg |

---

## 5. Implementation Roadmap

### Phase 1 (Current ΓÇö zk-credential exists)
- Nullifier storage via `persistent()`
- Hash-based commitment binding (SHA-256)
- Merkle root registry

### Phase 2 (Next)
- Deploy standalone ZK Verifier Node (Rust + Barretenberg)
- Add Ed25519 oracle signature verification to escrow contract
- Wire nullifier check into `claim()` flow

### Phase 3 (Future)
- Explore Soroban v28 precompile additions for BN254
- Replace oracle with on-chain Groth16 if precompiles land
- Multi-party oracle for high-value dispute resolution

---

## References

- Existing contract: `contracts/zk-credential/src/lib.rs`
- Noir circuits: `circuits/credential_verifier/`, `circuits/provider_reputation/`
- Soroban SDK v27 docs: https://soroban.stellar.org/docs
- ark-groth16: https://github.com/arkworks-rs/groth16
