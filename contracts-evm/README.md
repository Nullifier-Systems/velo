# contracts-evm

The EVM counterpart leg for Velo's cross-chain atomic swaps.

## HTLC.sol

A hashed-timelock contract that mirrors the Soroban `atomic-swap` state machine
on an EVM chain. It **uses SHA-256** (not keccak256) for the hashlock so the
same `secret` settles both legs:

- Soroban `atomic-swap` verifies `sha256(secret) == secret_hash`.
- `HTLC.sol` verifies `sha256(secret) == hashlock`.

| Function                                                                 | Purpose                                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `newSwap(bytes32 hashlock, address recipient, uint256 timelock) payable` | Lock ETH for `recipient`, claimable by revealing the preimage of `hashlock`.                 |
| `withdraw(bytes32 secret)`                                               | Claim by revealing the secret; the relayer calls this. Locates the swap by `sha256(secret)`. |
| `refund(bytes32 hashlock)`                                               | Return funds to the sender after `timelock`.                                                 |
| `hashOf(bytes32 secret) view`                                            | Convenience: the on-chain hashlock derivation.                                               |

Swaps are keyed by hashlock (one active swap per hashlock). If hashlock reuse is
a concern in production, namespace swaps by an explicit id as well.

This contract is intentionally kept out of the Node and Rust CI pipelines (no
solc toolchain is added to CI). Compile and deploy it with Foundry or Remix.

## Deploy with Foundry

```bash
forge create contracts-evm/HTLC.sol:HTLC \
  --rpc-url "$EVM_RPC_URL" \
  --private-key "$EVM_PRIVATE_KEY"
```

Then set `EVM_HTLC_ADDRESS` in `apps/relayer/.env`. See
[docs/cross-chain-relayer.md](../docs/cross-chain-relayer.md) for the full
end-to-end walkthrough.
