# Trade Chat: End-to-End Encryption

**Status:** Implemented
**Last reviewed:** 2026-07-21

## Context

Buyer/provider chat for a locked trade (`apps/api/src/routes/chat.ts`) coordinates real-world cash handoffs — exact meeting spot, timing — over a channel the backend previously read as plaintext. Anyone with access to the API process's memory or logs could read every message. This document describes the end-to-end encryption scheme that makes the backend a blind relay: it stores and forwards ciphertext only, and only the two trade participants can decrypt.

See `docs/pending-trade-chat-transport.md` for the WebSocket-vs-SSE transport decision this design sits on top of; the encryption scheme is agnostic to that choice, since it only cares about the shape of the payload being relayed.

## Threat model and its explicit limits

**In scope:** an operator, attacker, or subpoena with read access to the API's data (the in-memory message store, request logs, or a future database) sees only ciphertext, never message content.

**Out of scope for now — trust-on-first-use (TOFU):** the app has no wallet-signing integration yet (Freighter / Stellar Wallet Kit isn't wired into the frontend — see `docs/non-custodial-signing.md`), and the `participant` value used to authorize chat access today is an unauthenticated query-string parameter, not a signed proof of address ownership. That means there is currently no way to cryptographically bind an encryption public key to a specific Stellar address. A malicious or compromised backend could in principle publish its own key in place of a real participant's and machine-in-the-middle the conversation.

This is mitigated, not eliminated, by a **safety number**: a short fingerprint derived from both participants' public keys, shown in the chat UI. Because buyer and seller in this app meet in person to exchange cash, comparing this code out loud or side-by-side is a natural, low-friction step — the same mitigation Signal and WhatsApp use for their own TOFU key exchange. If the code doesn't match, participants should stop and not share sensitive details over the channel.

**Upgrade path:** once Freighter/Stellar Wallet Kit integration lands (`docs/non-custodial-signing.md`, Approach 1), the client can sign its published X25519 public key with the user's real Stellar Ed25519 key. The server (or the peer) can then verify that signature against the known trade participant address, removing the TOFU gap entirely without changing the wire protocol below.

## Why per-device keys instead of the Stellar key

Stellar accounts use Ed25519 (signing), not natively usable for X25519 Diffie-Hellman key agreement. More fundamentally, the client has no access to the user's Stellar secret key today — non-custodial signing is planned to go through a wallet extension (Freighter), which signs transactions but doesn't hand out the raw key for unrelated purposes like message encryption.

Instead, each browser/device generates its own X25519 keypair the first time it opens a trade chat, using `nacl.box.keyPair()` (tweetnacl). The keypair is persisted in `localStorage` under `velo:e2e:<ownAddress>` and reused across trades for that address/device. Clearing browser storage or switching devices generates a new keypair — this is expected and surfaces as a safety-number change (see below), the same as it would in Signal.

## Wire protocol

**Key publishing**

- `POST /api/v1/chat/:tradeId/keys?participant=<address>` — body `{ "publicKey": "<base64 X25519 public key>" }`. Authorized identically to chat itself (caller must be the trade's buyer or seller, trade must be `locked`). Publishing broadcasts `{ type: "peerKey", participant, publicKey }` to the room so an already-open peer socket picks it up immediately.
- `GET /api/v1/chat/:tradeId/keys?participant=<address>` — returns `{ buyer: KeyEntry | null, seller: KeyEntry | null }`, `KeyEntry = { publicKey, updatedAt }`. Exposed as a general introspection/fallback endpoint; the reference frontend client doesn't poll it, relying instead on the WebSocket `joined`/`peerKey` events below, which cover both the initial handshake and reconnects.
- On WebSocket connect, the `joined` frame includes the peer's current key if already published: `{ type: "joined", tradeId, participant, peerKey: KeyEntry | null }`.

**Messages**

- Client → server: `{ type: "message", data: { ciphertext: "<base64>", nonce: "<base64>" } }`. No plaintext, and no per-message sender-key claim — the server rejects any payload missing either field.
- Server → client (broadcast + history): the same `{ id, tradeId, sender, ciphertext, nonce, createdAt }` shape, with `sender` set to the authorized participant address, never a client-supplied claim.

Deliberately, the message envelope does **not** carry a sender public key. Decryption always uses the peer's key from the key directory (`joined`/`peerKey` events), not a value embedded in the message — otherwise a compromised server could swap in a different key on a single message without the safety number changing.

**Encryption primitive:** NaCl `box` — X25519 key agreement + XSalsa20-Poly1305 authenticated encryption — via the `tweetnacl` library (`mobile/frontend/src/lib/e2e.ts`). `box` derives the same shared secret from `(mySecret, peerPublic)` regardless of which side encrypted, so a sender can decrypt their own echoed-back messages with the same function used for inbound ones.

## Safety number

`computeSafetyNumber(pubkeyA, pubkeyB)` sorts the two public keys, concatenates them, hashes with SHA-256 (`crypto.subtle`), and formats the first 6 bytes as a `XXXX-XXXX-XXXX` hex code — the same regardless of which side computes it. It's shown in the chat header once the peer's key is known.

The first key seen for a peer in a given trade is pinned in `localStorage` (`velo:e2e:peer:<tradeId>`). If a later-fetched peer key doesn't match the pinned one, the UI shows a warning ("security code changed — verify before continuing") and disables sending until the user acknowledges it. This surfaces the TOFU risk instead of silently re-trusting a new key.

## Storage

Ciphertext and key-directory entries live in the same in-memory, per-process `Map` stores chat already used for plaintext (`apps/api/src/lib/chat-store.ts`, new `apps/api/src/lib/key-store.ts`) — this change is intentionally storage-agnostic and doesn't migrate chat to a database. Durable storage remains a separately tracked gap (`docs/pending-trade-chat-transport.md`); when it lands, these stores hold opaque ciphertext blobs either way, so no protocol change is needed.

## Files

- `apps/api/src/lib/chat-store.ts`, `apps/api/src/lib/key-store.ts` — message and key-directory storage.
- `apps/api/src/routes/chat.ts` — key publish/fetch routes, message envelope validation.
- `mobile/frontend/src/lib/e2e.ts` — keypair management, encrypt/decrypt, safety number.
- `mobile/frontend/src/hooks/useChat.ts`, `mobile/frontend/src/pages/Chat.tsx` — wiring and UI.
