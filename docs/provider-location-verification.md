# Low-Cost Provider Location Verification

**Issue:** [#208](https://github.com/Nullifier-Systems/velo/issues/208)  
**Status:** Research recommendation — **not a binding implementation spec**  
**Date:** 2026-07-21  
**Purpose:** Recommend low-cost approaches to verify that cash providers are physically located where they claim, without expensive geolocation APIs.

---

## 1. Scope and problem statement

Velo's cash provider model requires providers to register with a physical location (lat/lng) so nearby buyers can find them. The risk:

- **Fake/Sybil registrations:** A provider claims to be in Mexico City but is actually somewhere else, diluting the provider directory and misleading buyers.
- **Location drift:** A provider registers at one location but operates from another without updating their profile.
- **Sybil attacks:** One entity creates multiple fake provider accounts to appear more prevalent than they are.

**Goal:** Verify provider physical location at low cost, without depending on expensive third-party geolocation APIs.

---

## 2. Current anti-Sybil measures in Velo

Based on codebase analysis (`apps/api/src/routes/cash.ts`):

| Measure                            | Implementation                            | Limitation                                     |
| ---------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| $5 USDC registration fee           | Economic hurdle at `/cash/agents` POST    | Prevents free spam but doesn't verify location |
| IP address fingerprinting          | `countProvidersByNetwork(ip, deviceId)`   | VPN/proxy bypass; shared IPs (cafes, offices)  |
| Device ID fingerprinting           | `device_id` field in registration         | Can be spoofed; multiple devices per person    |
| Max 2 providers per network/device | Hard limit in `countProvidersByNetwork()` | Doesn't prevent distributed Sybil              |

**Missing:** No mechanism to verify the provider is actually at the claimed lat/lng.

---

## 3. Low-cost verification approaches

### 3.1 Periodic GPS-signed check-ins

**How it works:**

- Provider's mobile app periodically submits a signed GPS reading (lat/lng + timestamp + device attestation).
- Server compares check-in location against registered location.
- Providers outside a configurable radius (e.g., 5km) are flagged or demoted.

**Implementation cost:** Low — uses device-native GPS API (free).

**Pros:**

- Uses hardware already in every smartphone
- No third-party API costs
- Can be sampled (e.g., 1 check-in per day) to minimize battery impact
- Device attestation (Apple App Attest / Google Play Integrity) makes spoofing harder

**Cons:**

- GPS spoofing is possible on rooted/jailbroken devices
- Requires mobile app (doesn't work for web-only providers)
- Privacy concerns (continuous location tracking)
- Battery drain on low-end devices

**Spoofing resistance:** Medium — GPS spoofing requires technical skill; device attestation raises the bar significantly.

**Estimated implementation effort:** 2-3 days (mobile client + API endpoint + verification logic).

---

### 3.2 Community vouching / reputation network

**How it works:**

- Existing verified providers "vouch" for new providers by staking a small amount (e.g., 1 USDC).
- If the vouched provider is found to be fake, the voucher loses their stake.
- Trust score accumulates over time based on successful trades and vouches.

**Implementation cost:** Low — smart contract vouching function + API changes.

**Pros:**

- Zero API costs — purely on-chain economic mechanism
- Leverages existing provider network as decentralized verification
- Economic alignment: providers stake their own reputation
- Scales naturally with network growth

**Cons:**

- Cold start problem (no providers to vouch for initial providers)
- Collusion risk (fake providers vouching for each other)
- Doesn't directly verify physical location (verifies identity/reputation)
- Requires smart contract changes

**Spoofing resistance:** Low-Medium — economic cost deters casual Sybil attacks but determined attackers can create fake provider clusters.

**Estimated implementation effort:** 3-5 days (smart contract vouching + API + UI).

---

### 3.3 Challenge-response location proofs

**How it works:**

- Server sends a "location challenge" to a provider's app (e.g., "confirm you're at lat X, lng Y within 10 minutes").
- Provider's app responds with a signed GPS reading.
- If the challenge is failed or missed, the provider is flagged.

**Implementation cost:** Low — server-triggered challenge + device GPS.

**Pros:**

- Randomized timing makes pre-computed spoofing harder
- Can be triggered before first trade or periodically
- Combines well with device attestation
- No third-party API costs

**Cons:**

- Requires mobile app (push notification or polling)
- Provider can decline challenges (soft opt-out)
- GPS spoofing still possible on compromised devices
- Challenge logistics (timing, retries, failure handling)

**Spoofing resistance:** Medium-High — random timing + device attestation makes automated spoofing difficult.

**Estimated implementation effort:** 3-4 days (challenge system + mobile integration + verification API).

---

### 3.4 Wi-Fi/cell-tower location cross-check

**How it works:**

- Device submits Wi-Fi access point list or cell tower IDs alongside GPS coordinates.
- Server cross-references against public Wi-Fi/cell databases (e.g., Mozilla Location Service, OpenCellID) to verify the claimed location is plausible.

**Implementation cost:** Low-Medium — free databases exist but require integration.

**Pros:**

- No additional hardware required (Wi-Fi/cell data is always available)
- Free databases (Mozilla Location Service is open source)
- Harder to spoof than GPS alone (requires matching Wi-Fi environment)
- Works indoors where GPS is weak

**Cons:**

- Database accuracy varies (especially in rural areas)
- Requires internet access to query databases
- Privacy concerns (Wi-Fi scanning can reveal nearby networks)
- Not 100% reliable (new buildings, moved access points)

**Spoofing resistance:** Medium — requires matching Wi-Fi environment, which is harder than GPS spoofing but not impossible.

**Estimated implementation effort:** 4-6 days (Wi-Fi scanning client + database integration + verification logic).

---

### 3.5 Photo-based location verification

**How it works:**

- Provider submits a photo at their claimed location (e.g., storefront with street sign, landmark).
- Community or automated system verifies the photo matches the claimed location.
- Can be combined with EXIF metadata (timestamp, GPS if available).

**Implementation cost:** Low — photo upload + review system.

**Pros:**

- Human-verifiable (hard to fake a real storefront photo)
- No special hardware required (any phone camera)
- Can be reviewed by community or admin
- EXIF metadata provides additional signal

**Cons:**

- Manual review doesn't scale
- EXIF GPS can be stripped or spoofed
- Stock photos or screenshots can be used
- Requires moderation infrastructure

**Spoofing resistance:** Low-Medium — stock photos and screenshots are easy to use; EXIF is unreliable.

**Estimated implementation effort:** 2-3 days (photo upload + review queue + metadata extraction).

---

## 4. Comparison matrix

| Approach               | Cost           | Spoofing Resistance | Scalability | Mobile Required | Implementation Effort |
| ---------------------- | -------------- | ------------------- | ----------- | --------------- | --------------------- |
| GPS check-ins          | Free           | Medium              | High        | Yes             | 2-3 days              |
| Community vouching     | Free (+ stake) | Low-Medium          | High        | No              | 3-5 days              |
| Challenge-response     | Free           | Medium-High         | High        | Yes             | 3-4 days              |
| Wi-Fi/cell cross-check | Free           | Medium              | Medium      | Yes             | 4-6 days              |
| Photo verification     | Free           | Low-Medium          | Low         | No              | 2-3 days              |

---

## 5. Recommended approach: Layered verification

No single approach is sufficient. A layered strategy provides the best cost-to-security ratio:

### Layer 1: Registration verification (required)

- **GPS-signed check-in at registration time** — provider must submit a signed GPS reading from their device confirming they're at the claimed location.
- **Device attestation** — use Apple App Attest / Google Play Integrity to confirm the request comes from a genuine app on a non-rooted device.
- **Cost:** $0 | **Effort:** 2-3 days

### Layer 2: Ongoing verification (periodic)

- **Randomized location challenges** — server sends periodic challenges (1-2 per week) requiring a GPS response within a time window.
- **Trade-linked verification** — before releasing escrow funds, require a fresh GPS check-in from the provider confirming they're at or near the registered location.
- **Cost:** $0 | **Effort:** 3-4 days

### Layer 3: Community verification (graduated)

- **Vouching system** — existing providers can vouch for new providers (with small stake at risk).
- **Trust tiers** — providers accumulate trust through successful trades; higher trust = fewer location challenges.
- **Cost:** $0 (+ stake) | **Effort:** 3-5 days

### Layer 4: Anomaly detection (automated)

- **Pattern analysis** — flag providers with implausible movement patterns (e.g., teleporting between cities).
- **IP/Device correlation** — cross-reference registration IP with claimed location (GeoIP lookup, free via MaxMind GeoLite2).
- **Trade pattern analysis** — flag providers with unusual trade patterns (e.g., always trading at the same time as another provider from the same device).
- **Cost:** $0 | **Effort:** 2-3 days

---

## 6. Implementation roadmap

### Phase 1: Registration verification (MVP)

1. Add GPS check-in to provider registration flow
2. Integrate device attestation (Apple App Attest / Play Integrity)
3. Validate GPS coordinates against claimed location (within 1km)
4. Reject registration if GPS doesn't match

**Timeline:** 2-3 days  
**Priority:** High

### Phase 2: Ongoing verification

1. Implement challenge-response system for periodic location checks
2. Add GPS check-in requirement before trade release
3. Implement trust tier system (Probationary → Standard → Trusted)

**Timeline:** 3-4 days  
**Priority:** Medium

### Phase 3: Community and anomaly detection

1. Add vouching mechanism (smart contract + API)
2. Implement GeoIP cross-check at registration
3. Add anomaly detection for movement patterns
4. Implement automated flagging and review queue

**Timeline:** 5-7 days  
**Priority:** Low-Medium

---

## 7. Cost summary

| Component          | API/Service Cost       | Implementation Cost  | Total            |
| ------------------ | ---------------------- | -------------------- | ---------------- |
| GPS check-in       | $0 (device-native)     | 2-3 days dev time    | ~$0              |
| Device attestation | $0 (Apple/Google APIs) | 0.5 days integration | ~$0              |
| Challenge-response | $0 (server-triggered)  | 3-4 days dev time    | ~$0              |
| Community vouching | $0 (on-chain)          | 3-5 days dev time    | ~$0              |
| GeoIP cross-check  | $0 (GeoLite2 free DB)  | 1 day integration    | ~$0              |
| **Total**          | **$0**                 | **~10-14 days**      | **~$0 API cost** |

---

## 8. Sources to re-verify live

- Apple App Attest documentation: [developer.apple.com](https://developer.apple.com/documentation/devicecheck)
- Google Play Integrity API: [developer.android.com](https://developer.android.com/google/play/integrity)
- Mozilla Location Service: [location.services.mozilla.org](https://location.services.mozilla.org/)
- OpenCellID: [opencellid.org](https://www.opencellid.org/)
- MaxMind GeoLite2: [maxmind.com](https://www.maxmind.com/en/geoip2-databases)
- Stellar SEP-12 KYC: for potential integration with identity verification

---

## 9. Bottom line for #208

1. **No single low-cost method** fully prevents fake provider registrations.
2. **Layered approach** (GPS check-in + device attestation + community vouching) provides the best cost-to-security ratio.
3. **Total API cost: $0** — all recommended approaches use device-native APIs or free databases.
4. **Implementation effort: ~10-14 days** across all layers.
5. **MVP recommendation:** Start with GPS-signed registration check-in + device attestation (2-3 days, $0 cost).

_Prepared for Velo / Nullifier Systems open research. Not a binding implementation specification._
