# End-to-End Request Flow

This document details the end-to-end request flow of Velo, showing how the **User (Buyer)**, **Mobile Frontend**, **API Layer**, **Soroban Escrow Contract**, and **Merchant (Seller/Cash Provider)** connect and interact.

The transaction flow is split into three main phases:

1. **Escrow Locking (Initiation)**: Securing stablecoin funds on-chain (supporting both Custodial and Non-Custodial modes).
2. **Verification (QR Scanning)**: Physical meeting between the buyer and the cash provider, scanning the claim QR code to fetch details.
3. **Escrow Release (Cash Handoff)**: Submitting the release secret to the contract to trigger on-chain settlement, followed by handing over physical cash.

---

## Request Flow Diagram

```mermaid
sequenceDiagram
    autonumber
    actor User as User (Buyer)
    participant Frontend as Mobile Frontend
    participant API as API Layer
    participant Contract as Soroban Escrow Contract
    actor Merchant as Merchant (Seller)

    Note over User, Frontend: Phase 1: Lock Funds / Initiate Request
    User->>Frontend: Select amount and request cash
    Frontend->>Frontend: Generate Secret & Secret Hash (SHA-256)
    Frontend->>API: POST /api/v1/cash/request/prepare (secret_hash)

    alt Custodial Mode (Legacy / Testing)
        API->>Contract: Invoke lock() with secret_hash
        Contract->>Contract: Lock USDC/stablecoin funds
        API->>API: Save request status as 'locked'
    else Non-Custodial Mode (Production / Mainnet)
        API-->>Frontend: Return unsigned transaction XDR
        Frontend->>User: Prompt for wallet signature
        User-->>Frontend: Sign XDR (e.g., via Stellar wallet)
        Frontend->>API: POST /api/v1/cash/request/:id/submit (signed_xdr)
        API->>Contract: Submit signed transaction
        Contract->>Contract: Lock USDC/stablecoin funds
        API->>API: Save request status as 'locked'
    end

    API-->>Frontend: Return claim_url & QR payload (contains secret)
    Frontend->>User: Display Claim QR code

    Note over User, Merchant: Phase 2: QR Scanning & Verification
    User->>Merchant: Present Claim QR code in-person
    Merchant->>Frontend: Scan QR code using Merchant Terminal
    Frontend->>API: GET /api/v1/cash/request/:id (fetch details)
    API-->>Frontend: Return request details (status: locked)
    Frontend->>Merchant: Display verification screen

    Note over User, Merchant: Phase 3: Cash Handoff & Release
    Merchant->>User: Hand physical cash to user
    Merchant->>Frontend: Click "Confirm Handoff & Release"
    Frontend->>API: POST /api/v1/cash/request/:id/release (secret)
    API->>Contract: Invoke release() with secret
    Contract->>Contract: Verify secret and transfer USDC to Merchant
    API->>API: Update status to 'released'
    API->>Merchant: Send notification / Webhook alert (Slack/Discord)
    API-->>Frontend: Confirm release success
    Frontend-->>Merchant: Display success confirmation
```

---

## Detailed Step-by-Step Flow

### Phase 1: Escrow Locking (Initiation)

1. **User (Buyer)** initiates a cash withdrawal request on the mobile app.
2. **Mobile Frontend** generates a cryptographic `secret` and its hash (`secret_hash = sha256(secret)`) locally on the client device. The secret is never sent to the API gateway during initiation to preserve trust boundaries.
3. **Mobile Frontend** submits the request to the **API Layer** (`POST /api/v1/cash/request/prepare`).
4. Based on the selected `mode`:
   - **Custodial Mode**: The API gateway signs the lock transaction using a backend-held account, invoking the `lock` function on the **Soroban Escrow Contract** directly.
   - **Non-Custodial Mode**: The API gateway constructs an unsigned transaction XDR and returns it to the client. The User signs this transaction with their non-custodial Stellar wallet (e.g. Freighter) and submits the signed envelope to the API gateway (`POST /api/v1/cash/request/:id/submit`), which broadcasts it to the Stellar network.
5. Once confirmed, the **Soroban Escrow Contract** locks the USDC funds under the specified contract registry state.
6. The **API Layer** returns a `claim_url` and a `qr_payload` containing the `request_id` and the raw client-generated `secret`.
7. The **Mobile Frontend** renders this payload as a secure QR code for the user.

### Phase 2: QR Scanning & Verification

8. The **User** meets the **Merchant** in person and displays the Claim QR code.
9. The **Merchant** opens the **Merchant Release Terminal** on their frontend and scans the QR code.
10. The scanning terminal extracts the `request_id` and `secret` from the QR payload.
11. The merchant's frontend fetches transaction details from the **API Layer** (`GET /api/v1/cash/request/:id`) to display the locked amount, buyer address, and current status.
12. The **API Layer** verifies the database record and returns the metadata.
13. The merchant terminal displays the verification screen.

### Phase 3: Cash Handoff & Release

14. The **Merchant** hands the corresponding physical cash to the **User**.
15. Upon successful physical handoff, the merchant confirms the action on the terminal.
16. The merchant terminal calls the **API Layer** (`POST /api/v1/cash/request/:id/release`) containing the scanned `secret`.
17. The **API Layer** submits the release transaction to the **Soroban Escrow Contract**, passing the `secret`.
18. The **Soroban Escrow Contract** checks if `sha256(secret)` matches the stored `secret_hash`. If correct, the contract transfers the locked USDC funds to the merchant's Stellar account.
19. The **API Layer** marks the cash request status as `released` and sends real-time updates (via WebSockets/SSE) and optionally webhook alerts (Slack/Discord) and SMS/Email notifications to the user.
20. The **API Layer** returns a success status to the merchant terminal.
21. The merchant terminal shows a final transaction completion screen.
