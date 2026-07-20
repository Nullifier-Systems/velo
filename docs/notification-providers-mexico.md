# Notification Providers for Mexico — Research Report

**Prepared for:** Velo (fintech / Stellar-based payments, Mexico)
**Date:** July 2026
**Scope:** SMS, Push, WhatsApp, and Email providers for claim-status alerting

---

## Executive Summary

For a Mexico-focused fintech sending 1,000–10,000 claim-status notifications per month, the optimal stack is:

1. **SMS (primary):** A local Mexican aggregator (SMS Masivos or 402T Labs) — 4–14× cheaper than Twilio, direct carrier routes, CFDI invoicing, 98–99% deliverability.
2. **Push (secondary):** Firebase Cloud Messaging (FCM) — completely free, unlimited volume, but requires vendor-channel integration for Chinese-brand Android devices (Xiaomi, Huawei, OPPO, Vivo) which are prevalent in Mexico.
3. **WhatsApp (supplemental):** Twilio WhatsApp API or direct Meta API — $0.0085/utility message in Mexico, best for high-trust claim confirmations.
4. **Email (backup):** AWS SES at $0.10/1,000 emails — dramatically cheaper than SendGrid/Mailgun, but requires more setup.

**Key finding:** Twilio SMS is 4–14× more expensive than local Mexican aggregators for SMS. A local provider (SMS Masivos, 402T Labs) with direct carrier routes is strongly recommended for any Mexico-focused SMS program.

---

## 1. SMS Providers

### 1.1 Twilio

| Metric | Value |
|---|---|
| **Price per SMS (MX outbound)** | $0.1819 USD (~$3.64 MXN) |
| **Monthly number fee** | $6.50–$15 USD/month per number |
| **Failed message fee** | $0.001 per failed message |
| **Sender types** | International long code, alphanumeric sender ID (requires 3-week pre-registration), short code |
| **Carrier routes** | Indirect — uses international long codes, not direct carrier connections |
| **Deliverability** | Not publicly published for Mexico. Uses shared short code fallback for non-registered senders. |
| **Billing** | USD invoice (no CFDI) |
| **Support** | English, ticket-based |

**Pros:** Excellent SDK ecosystem (7+ languages), global reach, single-vendor for SMS+WhatsApp+Email+Voice, mature documentation.

**Cons:** 4–8× more expensive than local Mexican providers ($0.1819 USD vs ~$0.0125–$0.047 USD for locals). No direct carrier routes — uses international long codes. No CFDI invoicing. English-only support.

**Verdict:** Use Twilio only if you need multi-channel orchestration (SMS + WhatsApp + Email) from a single vendor and volume is low. For Mexico-only SMS, local providers are dramatically cheaper.

### 1.2 Local Mexican SMS Aggregators

#### SMS Masivos (smsmasivos.com.mx)

| Metric | Value |
|---|---|
| **Price per SMS** | $0.47–$0.90 MXN (~$0.025–$0.047 USD) depending on volume |
| **Volume tiers** | $0.90 MXN (500 SMS) → $0.47 MXN (80,000+ SMS) |
| **Carrier routes** | Direct to Telcel, Movistar, AT&T, Altán |
| **Deliverability** | 98–99% reported |
| **Throughput** | 120 msg/s |
| **Monthly fee** | $0 |
| **Sender IDs** | Short code (5-digit) for marketing, long code (10-digit) for collections, included |
| **Billing** | CFDI 4.0 in MXN, prepaid balance (no expiry) |
| **Support** | Spanish (chat + WhatsApp) |
| **API** | REST, Zapier, Make, Shopify, WooCommerce |

**Pros:** Direct carrier routes, best deliverability in Mexico, CFDI invoicing, Spanish support, no monthly fees.

**Cons:** Mexico-only coverage, smaller SDK ecosystem than Twilio.

#### 402T Labs (402tlabs.com)

| Metric | Value |
|---|---|
| **Price per SMS** | $0.26 MXN (~$0.013 USD) at low volume → $0.231 MXN (~$0.012 USD) at 50k+ |
| **Carrier routes** | Direct to Mexican carriers |
| **Deliverability** | High (direct routes) |
| **Billing** | MXN, CFDI compliant |
| **Support** | Spanish 24/7 |

**Pros:** Cheapest option at scale, direct routes, local compliance.

#### LabsMobile (labsmobile.com)

| Metric | Value |
|---|---|
| **Price per SMS** | From €0.0112–€0.0126 (~$0.012–$0.014 USD / ~$0.23–$0.25 MXN) |
| **Volume tiers** | 715–17,857 SMS: €0.0126; 17,858+: €0.0112 |
| **Monthly fee** | $0 |
| **Sender ID** | Alphanumeric supported on request |
| **Billing** | EUR (no CFDI) |

**Pros:** Competitive pricing, no monthly fees, Spanish support available.

**Cons:** Spanish company (no CFDI), routes less transparent than SMS Masivos.

### 1.3 Vonage / Nexmo

| Metric | Value |
|---|---|
| **Price per SMS (MX outbound)** | ~$0.0059–$0.0062 EUR (~$0.0064–$0.0067 USD) base, but carrier-specific surcharges apply |
| **Sender ID** | Alpha sender ID supported with pre-registration |
| **DLR** | SMSC-level by default; handset DLR requires dedicated short code (extra cost) |
| **Carrier routes** | Indirect — uses international routes |
| **Billing** | EUR, pay-as-you-go, no monthly minimum |

**Pros:** Competitive base pricing, good global coverage, Ericsson-backed infrastructure.

**Cons:** Mexico-specific pricing is not transparent (requires downloading CSV from dashboard). Carrier surcharges can add significant cost. No CFDI. English support.

### 1.4 Other SMS Aggregators

| Provider | Price (MXN) | Price (USD) | Notes |
|---|---|---|---|
| **Plivo** | ~$1.2 MXN (Telcel) | ~$0.06 | Higher than local, lower than Twilio |
| **Telnyx** | ~$1.64 MXN (long code) | ~$0.091 USD | Developer-friendly, no CFDI |
| **WauSMS** | ~$0.48 MXN | ~$0.024 EUR | Spanish provider, alphanumeric sender OK |
| **Altiria** | Dynamic pricing | — | Spanish provider, direct routes to Telcel/Movistar/Unefon |

---

## 2. Push Notification Providers

### 2.1 Firebase Cloud Messaging (FCM)

| Metric | Value |
|---|---|
| **Cost** | **Completely free** — unlimited messages, unlimited devices, no per-notification charge |
| **Platforms** | Android, iOS, Web |
| **Delivery** | FCM high-priority channel for time-sensitive messages |
| **Limitations** | 4KB payload max; delivery depends on Google Play Services availability |

**Mexico-specific considerations:**
- FCM is free and works well on Google-certified Android devices (Samsung, Motorola, Google Pixel) which are common in Mexico.
- **Chinese-brand devices** (Xiaomi, Huawei, OPPO, Vivo) have aggressive battery optimization that can suppress FCM delivery. Xiaomi and Huawei have significant market share in Mexico.
- For these devices, you need **vendor-specific push channels** (Xiaomi MiPush, Huawei HMS Push, OPPO Push, Vivo Push) as fallback.
- FCM high-priority messages can bypass some restrictions on non-Chinese devices.

**Verdict:** Use FCM as the primary push channel. For Chinese-brand devices (Xiaomi, Huawei, OPPO, Vivo), implement vendor push SDKs as fallback. This is standard practice for any Android app in Latin America.

### 2.2 OneSignal

| Metric | Value |
|---|---|
| **Free tier** | Unlimited mobile push, 10K emails/month, 10K web push subscribers |
| **Growth plan** | $19/month base + $0.012/MAU (mobile) + $0.004/web subscriber |
| **Professional** | Starting at $999+/month (annual contract) |
| **Email overage** | $1.50 per 1,000 sends beyond included |
| **SMS** | Requires sales quote (~$0.003/message) |

**Mexico-specific:** OneSignal offers local currency billing in Mexico through reseller partners. Push delivery depends on underlying FCM + vendor channels — same limitations as raw FCM.

**Verdict:** OneSignal adds convenience (multi-channel, analytics, segmentation) but costs scale with MAU. At 1,000–10,000 users, the free tier is sufficient. At scale, raw FCM + vendor SDKs is cheaper.

### 2.3 Other Push Services

| Provider | Pricing | Notes |
|---|---|---|
| **Pushwoosh** | Free up to 1,000 MAU; paid from $24/month | Multi-platform, vendor channel support |
| **Pushy** | Free up to 1,000 devices; $0.01/device after | FCM high-priority fallback for Chinese devices |
| **MoEngage** | Enterprise (custom quote) | Push Amplification for Chinese OEM devices |
| **CleverTap** | Enterprise (custom quote) | RenderMax SDK for OEM workarounds |

---

## 3. WhatsApp / Chat-Based Notifications

### 3.1 Twilio WhatsApp API

| Metric | Value |
|---|---|
| **Twilio channel fee** | $0.005 per message (inbound or outbound) |
| **Meta passthrough (Mexico)** | Marketing: $0.0305; Utility: $0.0085; Authentication: $0.0085; Service: Free |
| **Total per utility message (MX)** | $0.005 (Twilio) + $0.0085 (Meta) = **$0.0135** |
| **Total per marketing message (MX)** | $0.005 (Twilio) + $0.0305 (Meta) = **$0.0355** |
| **Total per authentication message (MX)** | $0.005 (Twilio) + $0.0085 (Meta) = **$0.0135** |
| **Service messages** | Free (Meta) + $0.005 (Twilio) = **$0.005** |

**Note:** Meta moved to per-message pricing on July 1, 2025 (replacing conversation-based pricing). Service messages (responses within 24-hour customer-initiated window) are free from Meta but still incur Twilio's $0.005 fee.

### 3.2 Bird (formerly MessageBird)

Bird charges Meta passthrough rates plus a platform markup. Pricing is typically quote-based for WhatsApp. They offer a SaaS management platform with omnichannel capabilities. No transparent per-message pricing published for Mexico.

### 3.3 Direct Meta WhatsApp Business API (via BSP)

| Category | Mexico Rate (USD) | Mexico Rate (MXN) |
|---|---|---|
| **Marketing** | $0.0305 | ~$0.5614 MXN |
| **Utility** | $0.0085 | ~$0.1565 MXN |
| **Authentication** | $0.0085 | ~$0.1565 MXN |
| **Service** | Free | Free |

**Volume tiers (utility, Mexico):**
- 0–250,000/mo: $0.0085 (list)
- 250,001–1,000,000: $0.0081 (−5%)
- 1,000,001–3,000,000: $0.0077 (−10%)
- 3,000,001–5,000,000: $0.0072 (−15%)
- 5,000,001–10,000,000: $0.0068 (−20%)
- 10,000,001+: $0.0064 (−25%)

**BSPs** (Twilio, Bird, Gupshup, WATI, etc.) add their own markup on top of Meta rates. Twilio's is $0.005/message. Others vary.

**Verdict:** WhatsApp is cost-effective for utility/authentication messages ($0.0085–$0.0135 each) but expensive for marketing ($0.0305+). For claim-status updates (utility category), it's viable. Requires template pre-approval by Meta.

---

## 4. Email Providers

### 4.1 AWS SES

| Metric | Value |
|---|---|
| **Price** | $0.10 per 1,000 emails |
| **Free tier** | 62,000 emails/month when sending from EC2 |
| **Dedicated IP** | $24.95/month per IP |
| **Deliverability** | 95.4% average inbox placement (with proper setup) |
| **Setup** | Manual DKIM/SPF/DMARC; sandbox mode initially |

**Mexico-specific:** SES has no special Mexico limitations. Deliverability to Mexican ISPs (Telmex, Axtel, Totalplay, Izzi) is generally good with proper authentication. No warm IP needed for low volume.

### 3.2 Twilio SendGrid

| Metric | Value |
|---|---|
| **Essentials** | $19.95/month for 50K emails (shared IP) |
| **Pro** | $89.95/month for 100K emails (dedicated IP included) |
| **Overage (Essentials 50K)** | $0.0013/email |
| **Overage (Pro 100K)** | $0.0011/email |
| **Free tier** | 60-day trial, 100 emails/day (permanent free tier removed March 2025) |
| **Dedicated IP** | Included in Pro; additional IPs $30/month each |

**Mexico-specific:** SendGrid has good deliverability to Mexican ISPs on dedicated IPs. On shared IPs (Essentials), deliverability is inconsistent (61–85% inbox placement reported). For a fintech sending transactional claim-status emails, Pro plan with dedicated IP is recommended.

### 3.3 Mailgun

| Metric | Value |
|---|---|
| **Flex (pay-as-you-go)** | $0.80 per 1,000 emails |
| **Foundation** | $35/month for 50K emails |
| **Scale** | $90/month for 100K emails (dedicated IP included) |
| **Free tier** | 30-day trial only |
| **Deliverability** | 86–90% inbox placement (shared IP); better on dedicated |

**Mexico-specific:** Good deliverability to Mexican ISPs. EU data residency available. Inbound email parsing is best-in-class.

---

## 5. Cost Comparison at Small Scale (1,000–10,000 notifications/month)

### Per-Notification Cost Estimates

| Channel | Provider | Cost per notification | Monthly cost (1,000) | Monthly cost (10,000) |
|---|---|---|---|---|
| **SMS** | SMS Masivos (local MX) | $0.025–$0.047 USD | $25–$47 | $250–$470 |
| **SMS** | 402T Labs (local MX) | $0.012–$0.013 USD | $12–$13 | $120–$130 |
| **SMS** | LabsMobile | $0.012–$0.014 USD | $12–$14 | $120–$140 |
| **SMS** | Twilio | $0.1819 USD | $182 | $1,819 |
| **SMS** | Vonage/Nexmo | ~$0.0064+ carrier surcharges | ~$7+ | ~$64+ |
| **Push (FCM)** | Free | $0 | $0 | $0 |
| **Push (OneSignal)** | Free tier (≤10K users) | $0 | $0 | $0 |
| **WhatsApp (utility)** | $0.0135 (Twilio) / $0.0085 (direct) | $8.50–$13.50 | $85–$135 |
| **WhatsApp (marketing)** | $0.0355 (Twilio) / $0.0305 (direct) | $30.50–$35.50 | $305–$355 |
| **Email (AWS SES)** | $0.0001 | $0.10 | $1.00 |
| **Email (SendGrid Essentials)** | ~$0.0004 (at 50K) | $19.95 flat | $19.95 flat |
| **Email (Mailgun Flex)** | $0.0008 | $0.80 | $8.00 |

### Cost Scenarios

**Scenario A: 1,000 claim-status notifications/month (SMS only)**

| Provider | Monthly cost |
|---|---|
| SMS Masivos (local) | $25–$47 |
| 402T Labs (local) | $12–$13 |
| LabsMobile | $12–$14 |
| Twilio | $182 |
| Vonage | ~$7+ (variable) |

**Scenario B: 10,000 claim-status notifications/month (SMS only)**

| Provider | Monthly cost |
|---|---|
| SMS Masivos (local) | $250–$470 |
| 402T Labs (local) | $120–$130 |
| LabsMobile | $120–$140 |
| Twilio | $1,819 |
| Vonage | ~$64+ (variable) |

**Scenario C: 10,000 multi-channel (5,000 SMS + 3,000 push + 1,000 WhatsApp + 1,000 email)**

| Channel | Provider | Cost |
|---|---|---|
| SMS (5,000) | 402T Labs | ~$65 |
| Push (3,000) | FCM | $0 |
| WhatsApp utility (1,000) | Twilio | $13.50 |
| Email (1,000) | AWS SES | $0.10 |
| **Total** | | **~$78.60/month** |

---

## 6. Mexico-Specific Deliverability Analysis

### 6.1 SMS Deliverability in Mexico

**Carrier market share (Mexico):**
- **Telcel (América Móvil):** ~58.7% — 76M subscribers. Most reliable for A2P SMS. Does not discriminate between aggregators.
- **Movistar (Telefónica):** ~16.7% — 22M subscribers. Previously obstructive, now reaching agreements with aggregators.
- **AT&T Mexico:** ~15.6% — 20M subscribers. Similar trajectory to Movistar.
- **Altán Redes:** Wholesale 4G/LTE operator (powers Bait/Walmart MVNO). **Actively blocking A2P SMS** as of mid-2025 — labels legitimate A2P traffic as spam, throttles throughput, and breaches interconnection agreements.

**Key deliverability risks:**
1. **Altán blocking:** Altán is actively obstructing A2P SMS aggregators. The IFT (Mexican regulator) opened investigation AI/DE-002-2024 for potential monopolistic practices. If your user base includes Altán subscribers (Bait MVNO), SMS delivery may be unreliable.
2. **Telcel is the gold standard:** Telcel does not discriminate — all traffic treated equally. With ~59% market share, most users will receive SMS reliably via Telcel.
3. **Anti-spam agreement (2024):** All major carriers signed an agreement to block spam. Legitimate A2P traffic (OTP, claim status) should not be affected, but aggressive filtering may catch some transactional traffic.
4. **Sender ID registration:** Alphanumeric sender IDs require 3-week pre-registration with Telcel and Movistar. Unregistered sender IDs get replaced with random short codes.
5. **Time restrictions:** Best practice is not to send SMS between 9PM–9AM Mexico time.

### Push Notification Deliverability on Mexican Android Devices

**Device market share in Mexico (approximate):**
- Samsung: ~30%
- Motorola: ~20%
- Xiaomi: ~15%
- Huawei: ~8%
- OPPO: ~5%
- Apple iOS: ~15%
- Others (LG, Nokia, Alcatel, Vivo): ~7%

**Key issues:**
- **Chinese OEM devices (Xiaomi, Huawei, OPPO, Vivo):** These manufacturers apply aggressive battery optimization that can suppress FCM push rendering. Delivery rates can drop to 10–20% on devices where the app hasn't been used recently.
- **Xiaomi:** Deprecated MiPush outside mainland China. FCM-only delivery now. Aggressive background kill.
- **Huawei:** No Google Play Services on newer devices (US sanctions). Requires HMS Push SDK for reliable delivery.
- **OPPO/Vivo:** Require "auto-start" permission to be manually enabled by the user for reliable push.
- **Samsung/Motorola:** Standard Android with Google Play Services. FCM works reliably (~95%+ delivery).

**Recommendation:** Use FCM as primary. For Xiaomi, Huawei, OPPO, and Vivo devices, integrate vendor-specific push SDKs (or use a service like Pushy or CleverTap that handles multi-vendor fallback). At small scale (1,000–10,000 users), the impact is manageable.

### Email Deliverability to Mexican ISPs

| ISP | Market Share (MX) | Deliverability Notes |
|---|---|---|
| **Telmex** | ~40% broadband | Good with DKIM/SPF/DMARC. Aggressive spam filtering. |
| **Axtel** | ~10% | Good deliverability with proper authentication. |
| **Totalplay** | ~15% | Moderate. Some filtering of new sending IPs. |
| **Izzi** | ~15% | Similar to Totalplay. |
| **Megacable** | ~8% | Generally good. |

**Key considerations for Mexico email:**
- All major providers (SES, SendGrid, Mailgun) deliver well to Mexican ISPs when properly configured with DKIM, SPF, and DMARC.
- **Dedicated IP recommended** above 50K/month for consistent reputation.
- Mexican ISPs are increasingly using DMARC enforcement. Ensure your domain has proper DMARC policy (p=quarantine or p=reject).
- SES is the most cost-effective option at $0.10/1,000 emails. At 1,000–10,000 emails/month, cost is negligible ($0.10–$1.00).

---

## 7. Provider Comparison Table

| Category | Provider | Cost/msg (USD) | Monthly fee | MX-specific | CFDI | Deliverability (MX) | Best for |
|---|---|---|---|---|---|---|---|
| **SMS** | SMS Masivos | $0.025–$0.047 | $0 | Direct carrier routes | Yes | 98–99% | Primary SMS in Mexico |
| **SMS** | 402T Labs | $0.012–$0.013 | $0 | Direct carrier routes | Yes | High | Lowest-cost SMS |
| **SMS** | LabsMobile | $0.012–$0.014 | $0 | Direct routes (claimed) | No | Not published | Budget SMS |
| **SMS** | Twilio | $0.1819 | $6.50–$15/num | International long code | No | Variable | Multi-channel vendor |
| **SMS** | Vonage/Nexmo | ~$0.0064+ | $0 | Indirect routes | No | Variable | Low base rate |
| **Push** | FCM | **Free** | $0 | N/A | N/A | 95%+ (Samsung/Moto) | Primary push |
| **Push** | OneSignal | Free–$19+$0.012/MAU | $0–$19 | Local MX billing available | No | Same as FCM | Managed push |
| **WhatsApp** | Twilio WA | $0.0135 (utility) | $0 | Yes | No | High | Claim confirmations |
| **WhatsApp** | Direct Meta API | $0.0085 (utility) | $0 | Yes | No | High | High-volume WA |
| **Email** | AWS SES | $0.0001 | $0 | N/A | No | 95%+ (configured) | Lowest-cost email |
| **Email** | SendGrid | $0.0004–$0.0013 | $19.95+ | N/A | No | 87–91% | Managed email |
| **Email** | Mailgun | $0.0008 | $0–$35 | N/A | No | 86–90% | Developer email |

---

## 8. Recommendations for Velo

### Primary Recommendation: Multi-Channel with Local SMS

```
SMS (primary):    402T Labs or SMS Masivos — $12–$130/month for 1K–10K messages
Push (secondary):  FCM (free) + vendor SDKs for Xiaomi/Huawei/OPPO/Vivo
WhatsApp (supplemental): Twilio WhatsApp API — $13.50/1K utility messages
Email (backup):    AWS SES — $0.10–$1.00/month for 1K–10K emails
```

**Total estimated monthly cost at 10K notifications:** ~$80–$200 depending on channel mix.

### Why Not Twilio for SMS in Mexico?

Twilio charges $0.1819/msg for Mexico SMS — 4–14× more than local providers. At 10,000 messages/month, that's $1,819 vs $120–$130 with 402T Labs. The only reason to use Twilio is if you need a single vendor for SMS + WhatsApp + Email and volume is very low.

### Implementation Priority

1. **Start with FCM push** (free, instant) for all users with Google Play Services
2. **Add local SMS** (402T Labs or SMS Masivos) for users without push capability or as fallback
3. **Add WhatsApp** for high-value claim-status updates (utility category, $0.0085/message)
4. **Add email via SES** for detailed claim documentation
5. **Monitor Altán situation** — if your user base includes Bait MVNO subscribers, have a fallback plan

### Risk Mitigation

- **Altán blocking:** If you have Altán/Bait users, consider routing their SMS through a different provider or using WhatsApp as alternative.
- **Chinese OEM push:** Implement vendor SDKs or use a service like Pushy that handles multi-vendor fallback.
- **Regulatory:** Ensure compliance with IFT regulations, REPEP, and the 2024 anti-spam agreement. Register sender IDs with Telcel/Movistar (3-week lead time).
- **WhatsApp template approval:** Meta requires pre-approval of message templates. Start the approval process early for claim-status templates.
