# Design Decisions

This document records the high-level choices that shape the current Velo codebase.

## Separation of Settlement and Experience

The repository separates on-chain settlement logic from the user-facing experience. This keeps the smart contracts as the trust anchor while allowing the application layers to evolve independently.

## Modular Workspace Structure

The monorepo structure allows the API, frontend, mobile backend, shared package, and contracts to evolve in parallel while sharing common interfaces and metadata.

## Payment-Aware API Access

The API uses a lightweight payment challenge model to gate access and establish a path toward real payment-backed authorization.

## QR-Centric User Experience

The mobile frontend is designed around simplified claim flows that can be shared through links or QR codes.

## QR Payload Persistence and Secret-in-URL Safety

The `POST /cash/request` handler persists `qrPayload` on `CashRequestRecord` and returns it as `qr_payload` in the 201 response. The `GET /cash/request/:id` handler returns the persisted value alongside the request's public fields.

**Why this is safe:** The workflow intentionally keeps the claim secret (the SHA-256 preimage) client-side. The API never receives it — only `secret_hash` (the hash) is stored. The QR payload / claim URL carry only `request_id` and `contract` — neither of which is a secret. The `GET /cash/request/:id` response explicitly strips `secretHex` via destructure (`const { secretHex: _omit, ...safe } = record`), so even though the record has a `secretHex` field (populated as `""`), it is never exposed.

**Why persist it:** Issue #58 identifies that when a request transitions to `released` or `refunded`, the original `qr_payload` is no longer available from the POST response (which clients may not have retained). Persisting it alongside the record means any past claim URL or QR payload can be reconstructed for debugging, receipt display, or support without re-exposing any secret material.
