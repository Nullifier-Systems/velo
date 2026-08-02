# Frequently Asked Questions

## What is Velo?

Velo is an open-source platform for escrow-backed, privacy-aware cash liquidity flows on Stellar.

## Is Velo production-ready?

The repository contains the core architecture and initial implementation, but some parts remain under active development and should be treated as evolving infrastructure.

## How do I start contributing?

Begin with the README and CONTRIBUTING guide, then select a small issue or documentation improvement.

## Where does settlement happen?

Settlement logic is centered in the Soroban smart contracts, with the API layer coordinating integration.

## What if a trade gets stuck mid-hand-off?

Before the escrow timeout, funds stay locked: retry the QR hand-off, chat if available, or raise a dispute for arbitrator resolution. After timeout, anyone can call permissionless refund (funds return to the buyer). Operators cannot bypass the contract timeout with an API key alone. See [docs/stuck-trades.md](docs/stuck-trades.md).

## How are payments authenticated?

The current API uses a payment-aware challenge flow based on an x402-style header pattern. This is a placeholder for stronger on-chain verification in future iterations.
