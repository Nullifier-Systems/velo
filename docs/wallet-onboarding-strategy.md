# Architecture Research: Embedded/Custodial-Lite Wallets vs. Extension-Based Wallets (Freighter)

_Disclaimer: This document is a technical research summary mapping architectural approaches and security trade-offs for embedded wallet implementation within the Stellar/Soroban ecosystem. It is intended to guide engineering design decisions._

---

## 📊 Approach Comparison Matrix

To optimize user activation paths, we compare the baseline extension model against two modern embedded wallet paradigms natively compatible with TypeScript/React applications and the Stellar network.

| Feature / Criteria      | 1. Traditional Extension (Freighter)                                           | 2. Embedded WaaS (e.g., Privy / Dynamic)                                   | 3. Native Passkeys / WebAuthn (Soroban Smart Wallets)                          |
| :---------------------- | :----------------------------------------------------------------------------- | :------------------------------------------------------------------------- | :----------------------------------------------------------------------------- |
| **Onboarding Friction** | **High** (Requires download, seed phrase backup, browser extension extension). | **Low** (One-click Social Login via OAuth: Google, Discord, Email).        | **Low** (Biometric touch/face ID registration via native hardware elements).   |
| **Key Custody Model**   | Non-custodial (User manages native private keys locally).                      | Hybrid/Co-custodial (Sharded keys via Shamir's Secret Sharing or MPC).     | Non-custodial (Keypair securely isolated inside hardware Secure Enclave).      |
| **UX Context**          | Interruptive popups; desktop-centric apps (mobile requires deep linking).      | Seamlessly embedded within application modals; full mobile responsiveness. | Instant confirmation signatures natively inside the browser execution layer.   |
| **Ecosystem Maturity**  | Production-proven standard for Stellar/Soroban protocols.                      | Integrated support for Stellar via modern developer infrastructure tools.  | Built directly over Soroban's native account abstraction and validation logic. |

---

## 🔒 Detailed Security & Operational Trade-offs

### 1. Traditional Extension (Freighter Wallet)

- **The Good:** Cryptographically isolated from the dApp. Compromising the `VELO` web application front-end via cross-site scripting (XSS) or supply-chain vectors cannot expose the user's root private key.
- **The Bad:** Drops onboarding conversion rates significantly. Users must leave the app interface, manage standalone browser permissions, and assume absolute responsibility for key recovery.

### 2. Embedded Wallet-as-a-Service (MPC / Key Sharding)

- **The Good:** Drastically reduces friction. The private key is split into multiple shards (e.g., one held by the authentication provider, one stored on the user's local device/cloud backup, and one generated from their social identity). No single party holds the full key.
- **The Bad:** Introduces structural dependencies on third-party relay infrastructure and OAuth providers. If an XSS vulnerability compromises the client session wrapper, an attacker could potentially programmatically force unauthorized signatures.

### 3. Native Passkeys via WebAuthn (Soroban Smart Wallets)

- **The Good:** Eliminates seed phrases entirely while preserving pure non-custodial cryptographic guarantees. Keys use native Elliptic Curve signatures supported on-chain by Soroban (`secp256r1`). They are generated inside the device’s hardware secure element (e.g., Secure Enclave) and authorized via biometric scanning.
- **The Bad:** If a user loses physical access to all registered hardware devices without configuring secondary recovery guardians or multi-sig fallbacks, recovery becomes structurally impossible.

---

## 🎯 Architecture Recommendation

For the **`VELO`** platform workspace ecosystem, a **Hybrid Passkey + Embedded WaaS Strategy** is recommended to capture both crypto-native and non-crypto-native user segments cleanly:

1. **Primary Interface:** Implement a lightweight embedded wallet framework using social logins as the absolute default path for new non-crypto users.
2. **Advanced Security Path:** Expose an immediate option within user profile settings to upgrade the account layer into a **Passkey-bound Soroban Smart Wallet**, removing dependency on social provider availability.
3. **Legacy Fallback:** Keep a standard connection interface available for power users who explicitly prefer using external hardware or browser extensions like Freighter.
