# Smart Contracts

The contract workspace in this repository currently includes the core escrow implementation and supporting abstractions.

## Escrow Contract

The escrow contract implements a simple HTLC-style release flow. It locks stablecoin funds from a buyer and allows them to be transferred to a seller only when the correct secret is revealed.

## HTLC Core

The HTLC core crate provides shared types and interfaces used by the escrow contract and future contract components.

## Atomic Swap

The atomic-swap crate implements the Stellar leg of a cross-chain HTLC. It
implements the same `htlc-core::Htlc` state machine as escrow (lock/release/
refund), charges no platform fee, and — critically — its `release()` publishes
the revealed secret in an event so an off-chain relayer can claim the
counterpart HTLC on another chain. See
[docs/cross-chain-relayer.md](cross-chain-relayer.md) for the relayer and the
end-to-end demo, and [docs/relayer-architecture.md](relayer-architecture.md) for
the design rationale.

## Operational Notes

- contract state should remain simple and auditable,
- contract behavior should be documented clearly,
- release and refund paths should be validated carefully before deployment.
