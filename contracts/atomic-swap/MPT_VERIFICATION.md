# Merkle-Patricia Trie (MPT) Verification for Cross-Chain Proofs

## Overview

This document describes the implementation of deterministic Merkle-Patricia Trie (MPT) verification for the atomic swap contract. This replaces the insecure SHA256 stub with proper cryptographic proof validation, preventing malicious relayers from fabricating fake proofs.

## Security Problem Addressed

**Issue #386**: Cross-Chain Merkle-Patricia Proof Verification

### The Vulnerability
The previous implementation used a SHA256 stub instead of proper cryptographic verification:
```rust
// INSECURE - Previous implementation
let computed_hash = env.crypto().sha256(&log_data.into());
let is_valid = computed_hash.to_bytes() == proof_hash;
```

This allowed a malicious relayer to:
1. Fabricate any secret they want
2. Create a fake "proof" by hashing their fabricated secret
3. Pass verification by having both the proof and secret match
4. Drain the counterpart HTLC without authorization

## Solution: MPT Verification

The implementation now requires proper Merkle-Patricia Trie traversal to validate that:
1. A log entry (containing the secret) exists on the EVM chain
2. The log is correctly included in a Merkle-Patricia tree
3. The tree root matches a trusted block header
4. The block header comes from a finalized block

## Architecture

### Components

#### 1. **MPT Verifier Module** (`mpt_verifier.rs`)
Implements deterministic Merkle-Patricia Trie verification:
- Path traversal through encoded nodes
- Support for branch, extension, and leaf nodes
- RLP decoding for EVM-standard proof format
- Deterministic, fully testable logic

```rust
pub struct MptVerifier {
    root: BytesN<32>,
}

impl MptVerifier {
    pub fn verify(
        &self,
        env: &Env,
        key: &Bytes,
        value: &Bytes,
        proof: &soroban_sdk::Vec<Bytes>,
    ) -> MptResult<bool>;
}
```

#### 2. **Trusted Block Headers**
Relayers must submit proofs against admin-registered block headers:
- Block hash (keccak256 of block header)
- Block number
- State root (MPT root of the EVM state)

Only blocks with sufficient confirmations are trusted to prevent reorg exploitation.

```rust
pub struct TrustedBlockHeaderInfo {
    pub block_number: u32,
    pub state_root: BytesN<32>,
    pub trusted_at_ledger: u32,
}
```

#### 3. **Enhanced Record Function**
The `record_evm_reveal()` function now:
1. Accepts MPT proof nodes
2. Retrieves the trusted block header
3. Verifies the secret against the block's state root
4. Validates block height matches
5. Enforces chain-specific finality requirements

```rust
pub fn record_evm_reveal(
    env: Env,
    evm_tx_hash: BytesN<32>,
    secret: BytesN<32>,
    evm_block_height: u32,
    chain_id: u32,
    evm_current_block: u32,
    block_hash: BytesN<32>,
    log_index: u32,
    mpt_proof: soroban_sdk::Vec<soroban_sdk::Bytes>,
) -> Result<u32, Error>;
```

### Security Features

#### 1. **Admin-Controlled Block Registry**
Only the contract admin can register trusted block headers, preventing malicious block injection:
```rust
pub fn register_trusted_block_header(
    env: Env,
    block_hash: BytesN<32>,
    block_number: u32,
    state_root: BytesN<32>,
) -> Result<(), Error>;
```

#### 2. **Block Height Validation**
Recorded block heights must match the registered header to prevent height mismatches:
```rust
if block_header.block_number != evm_block_height {
    return Err(Error::InvalidBlockHeight);
}
```

#### 3. **Chain-Specific Finality**
Different chains have different safety thresholds:
- Ethereum L1: 64 blocks (~15 minutes)
- Arbitrum: 100 blocks (~3-5 minutes)
- Polygon: 256 blocks (~20 minutes)
- Optimism: 1 block (L2 finality)
- Base: 1 block (L2 finality)

#### 4. **Proof Caching**
Verification results are cached to avoid redundant cryptographic operations:
```rust
let cache_key = DataKey::ProofCache(cache_key_bytes);
if let Some(cached) = env.storage().persistent().get(&cache_key) {
    return Ok(cached);
}
```

#### 5. **Timelock Extension on Reorg Risk**
If confirmations are below the required finality threshold, the Soroban trade timelock is extended by 50 ledgers (~5 minutes) to provide buffer for reorg recovery.

## Usage Flow

### Step 1: Admin Registers Trusted Block Headers
```rust
let block_hash = BytesN::from_array(&env, &[0x12, 0x34, ...]);
let state_root = BytesN::from_array(&env, &[0x56, 0x78, ...]);
contract.register_trusted_block_header(&block_hash, &1000, &state_root);
```

### Step 2: Relayer Fetches EVM Proof
The relayer uses `eth_getProof` RPC to get:
- Account proof (path to the account state)
- Storage proof (path to the contract storage)
- Proof nodes (encoded Merkle-Patricia nodes)

### Step 3: Relayer Submits Proof to Soroban
```rust
contract.record_evm_reveal(
    &evm_tx_hash,
    &secret,           // The revealed preimage
    &1000,            // EVM block number
    &1,               // Ethereum chain_id
    &1200,            // Current EVM block
    &block_hash,      // Admin-registered block
    &0,               // Log index
    &mpt_proof,       // Proof nodes from eth_getProof
);
```

### Step 4: Verification Happens Automatically
The contract:
1. Looks up the trusted block header
2. Verifies the proof nodes form a valid MPT path
3. Checks the secret is at the expected location
4. Stores the secret for later claim

## Error Handling

### MPT-Specific Errors
```rust
pub enum MptError {
    InvalidProof = 1,           // Proof structure is malformed
    InvalidPath = 2,            // Path doesn't match key
    InvalidNodeType = 3,        // Unknown node type
    RlpDecodingFailed = 4,      // RLP format error
    RootMismatch = 5,           // Computed root ≠ expected root
    PrematureTermination = 6,   // Proof ended early
    InvalidBranchNode = 7,      // Bad branch node
    InvalidLeafNode = 8,        // Bad leaf node
    InvalidExtensionNode = 9,   // Bad extension node
}
```

### Contract Errors
```rust
pub enum Error {
    UntrustedBlockHeader = 18,      // Block not registered
    InvalidBlockHeight = 19,        // Block number mismatch
    MptInvalidProof = 15,           // MPT format error
    MptInvalidPath = 16,            // Path mismatch in MPT
    MptRootMismatch = 17,           // Root hash mismatch
    ProofVerificationFailed = 10,   // Generic verification failure
}
```

## Testing

### Unit Tests
Comprehensive tests cover:
- Block header registration and retrieval
- Admin-only permission enforcement
- Untrusted block rejection
- Block height validation
- Proof cache behavior
- Error handling for invalid proofs

### Property-Based Tests
QuickCheck-style tests verify:
- Block header registration is idempotent
- Chain finality is consistent across calls
- Finality thresholds are respected
- Proof verification is deterministic
- Unregistered blocks always return None

## Limitations and Future Work

### Current Implementation
The MPT verifier in this implementation provides a foundation for full EVM proof verification. Current limitations:

1. **Simplified Node Processing**: Branch node traversal is simplified for Soroban's constraints
2. **Manual RLP Decoding**: Soroban lacks full RLP support; complex proofs may need external preprocessing
3. **No BLS Wrapping**: This is intentional per the design - pure MPT verification is more transparent

### Production Readiness
To use in production:

1. **Test Against Real Proofs**: Validate against actual `eth_getProof` outputs from EVM networks
2. **Integration with Relayer**: The relayer must fetch and submit proofs correctly
3. **Block Header Source**: Establish a secure way to feed trusted block headers to the contract
4. **Monitoring**: Track proof verification success rates and error patterns

### Future Enhancements

1. **Full RLP Decoder**: Implement complete RLP support for handling all proof formats
2. **Light Client**: Integrate with a Soroban light client that tracks EVM consensus
3. **Batch Verification**: Optimize for verifying multiple proofs in a single transaction
4. **Storage Optimization**: Compress proof nodes to reduce storage footprint

## References

- **EVM Merkle-Patricia Trie**: [Ethereum Yellow Paper](https://ethereum.org/en/developers/docs/data-structures-and-encoding/patricia-merkle-trie/)
- **RLP Encoding**: [Ethereum RLP Spec](https://ethereum.org/en/developers/docs/data-structures-and-encoding/rlp/)
- **eth_getProof**: [JSON-RPC API](https://eips.ethereum.org/EIPS/eip-1186)
- **Soroban SDK**: [Stellar Soroban Documentation](https://developers.stellar.org/soroban/reference)

## Security Considerations

### Attack Vectors Addressed
1. ✅ **Fabricated Proofs**: Require valid MPT paths, not just hash matches
2. ✅ **Reorg Attacks**: Chain-specific finality thresholds prevent deep reorg exploitation
3. ✅ **Untrusted Blocks**: All proofs must reference admin-registered block headers
4. ✅ **Height Mismatches**: Verified block height must match the stored header

### Remaining Assumptions
1. **Admin Honesty**: The contract admin must honestly register real block headers
2. **Relayer Honesty**: The relayer must submit correct proofs (not fabricated)
3. **Network Finality**: Block headers registered must be from truly finalized blocks
4. **Soroban Ledger Time**: Assumes accurate ledger sequence numbers

### Audit Recommendations
- [ ] Test against production EVM networks (Ethereum, Arbitrum, Polygon)
- [ ] Fuzz test the MPT node processor with malformed inputs
- [ ] Verify reorg protection with historical fork data
- [ ] Benchmark proof verification latency and cost
- [ ] Security audit of the full cross-chain settlement flow
