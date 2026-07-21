# Mexico Cash-Handling Network Landscape: Research Report for Velo

**Date:** July 2026
**Context:** Velo (Stellar-based payments company) evaluating Mexico expansion to accelerate merchant network growth.

---

## Executive Summary

Mexico remains a profoundly cash-dependent economy. Approximately 42% of adults lack a bank account, and an estimated 66-88% of transactions (depending on measurement methodology) still involve cash. For a Stellar-based payments company like Velo, this creates both a challenge and an opportunity: digital rails need physical on/off ramps.

The Mexican cash-handling network is dominated by a small number of large retail chains that function as de facto banking correspondents. **OXXO** (FEMSA) is the undisputed leader with ~24,300 stores nationwide and its own digital ecosystem (Spin by OXXO). **7-Eleven Mexico**, **Walmart Mexico** (Walmex), **Soriana**, **Chedraui**, **Circle K**, and **Telecomm** (the government-owned telecom/financial agency) collectively add tens of thousands more access points.

The most important recent development is **tapi's acquisition of Mastercard's Arcus operations in Mexico (June 2025)**. Arcus was the primary middleware layer connecting fintechs to these retail cash networks. Tapi now owns that infrastructure, serving clients including Mercado Pago, Nubank, Stori, and over 110 regional clients. Tapi processes ~25 million monthly transactions in Mexico and provides a single-API gateway to OXXO, 7-Eleven, Chedraui, Walmart, Soriana, and others.

**Key finding:** Direct partnerships with individual retail chains are difficult and slow for a non-Mexican fintech. The proven path is to integrate via an aggregator/middleware provider — either tapi (the market leader post-Arcus acquisition) or a competitor like Rapyd, EBANX, or dLocal.

---

## 1. Detailed Partner Profiles

### 1.1 OXXO (FEMSA)

| Metric                  | Value                                |
| ----------------------- | ------------------------------------ |
| Parent                  | FEMSA (Fomento Económico Mexicano)   |
| Stores in Mexico (2025) | 24,297 (up from 23,206 in 2024)      |
| Total across Americas   | 25,587                               |
| Daily customers         | ~13-14 million                       |
| Founded                 | 1978                                 |
| Ownership structure     | Publicly traded; FEMSA listed on BMV |

**Services Offered:**

- **OXXO Pay:** Cash payment for e-commerce purchases. Customer receives a barcode/voucher code, pays in-store. Launched ~2017. Accounts for ~~10% of Mexico's online transactions (~~$6B in volume).
- **Bill payments:** Utilities, telecom, taxes, credit cards.
- **Money transfers/remittances:** Partnerships with Western Union, MoneyGram, and others.
- **Spin by OXXO:** FEMSA's own digital wallet and financial services platform. Part of FEMSA's "Ecosystem 2.0" strategy. Offers prepaid cards, transfers, and payments. Recently delayed banking license application.
- **Cash deposits and withdrawals:** Partners with Nubank (since Jan 2025), Mercado Pago, and other fintechs for cash-in/cash-out services. Uses Arcus/tapi infrastructure.
- **Prepaid cards:** Bitz and other gift/prepaid products.

**Financial Services Gross Margin:** OXXO explicitly noted in its 3Q25 earnings that "growth in commercial income and financial services" drove gross margin expansion. Financial services are a strategic profit center.

**Partnership Model:**
OXXO works through middleware aggregators. The primary integration has been through Arcus by Mastercard (now owned by tapi). When Nubank partnered with OXXO in January 2025, it was explicitly "built on Arcus by Mastercard infrastructure." Fees are typically per-transaction, and limits apply (~MX$10,000-15,000 per transaction depending on service).

**Velo Relevance:**
OXXO is the single most important cash partner in Mexico. However, direct partnership is unlikely for a non-bank foreign entity. The realistic path is through tapi or another aggregator.

---

### 1.2 7-Eleven Mexico

| Metric             | Value                                                |
| ------------------ | ---------------------------------------------------- |
| Parent             | Grupo Iconn (Mexico franchisee of 7-Eleven Inc.)     |
| Stores in Mexico   | ~1,800+ across 14 states                             |
| Operating hours    | 6 AM - 10 PM (varies by region)                      |
| Key differentiator | First convenience store chain globally; strong brand |

**Services Offered:**

- **Bank deposits and payments:** Cash deposits to accounts at BBVA, Banorte, Santander, HSBC, Scotiabank, Banamex, Inbursa, and others. Limits: MX$3,000-5,000 per transaction depending on bank.
- **Credit card payments:** Payments toward credit cards at major banks.
- **Bill payments:** Utilities, services, government fees.
- **Western Union remittances:** Partnership announced March 2023. Send/receive money at 1,800+ locations to 200+ countries.
- **OXXO Pay alternative:** 7-Eleven is listed in Rapyd's Mexico Cash Network as `mx_7eleven_cash`. Transaction limit: up to MX$15,000.

**Technical Partnership:**
7-Eleven was an early Arcus partner (announced March 2020). Arcus powered their mobile app for bill payments, using barcode-based payments. With the tapi acquisition of Arcus, 7-Eleven is now part of tapi's network. Also integrated via Rapyd and other payment aggregators.

**Velo Relevance:**
A secondary but important partner. Smaller footprint than OXXO but complementary geographic coverage. Accessible through the same aggregator channels.

---

### 1.3 Walmart Mexico (Walmex / Walmart de México y Centroamérica)

| Metric                  | Value                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| Parent                  | Walmart Inc. (NYSE: WMT)                                                |
| Stores in Mexico        | ~3,000+ (includes Walmart, Walmart Express, Bodega Aurrera, Sam's Club) |
| Annual revenue (Mexico) | ~$48B+ USD                                                              |
| MVNO (BAIT)             | 18.3M+ subscribers; fastest-growing telecom in Mexico                   |

**Services Offered:**

- **Cashi:** Walmart's own digital wallet/payment platform. 5M+ users. Enables in-store cash payments for online orders.
- **Cash deposits/payments:** Customers can deposit cash and pay credit cards at 2,500+ Walmart/Bodega stores. Partnership with Banorte for deposits (since 2020).
- **BAIT + Fintech:** Walmart operates Mexico's fastest-growing MVNO (BAIT), selling smartphones and telecom services. Has integrated MiMedia into BAIT smartphones. Potential future financial services play.
- **Remittance pickup:** Partners with Félix Pago and others for cash pickup at Walmart locations.
- **Transaction limits:** Via Rapyd network — up to MX$30,000 per transaction at Walmart, Walmart Express, Sam's Club, Bodega Aurrera.

**Partnership Model:**
Walmart Mexico is more closed than OXXO. It has its own digital ambitions (Cashi, BAIT) and tends to partner with established players (Banorte, Mercado Pago). However, it is available through the tapi/Arcus network and through aggregators like Rapyd.

**Velo Relevance:**
Important but harder to access directly. Walmart may eventually become a competitor (they have the customer base and digital wallet infrastructure). Partnership via tapi is the most realistic path.

---

### 1.4 Soriana

| Metric      | Value                                                          |
| ----------- | -------------------------------------------------------------- |
| Head office | Chihuahua, Mexico                                              |
| Stores      | ~800+ nationwide                                               |
| Brands      | Soriana Hiper, Soriana Mercado, Soriana Súper, Soriana Express |
| Type        | Mexican-owned, publicly traded                                 |

**Services Offered:**

- **Cash deposits:** Direct partnership with Nu (via Arcus/Mastercard) since March 2024. Customers generate a code in the Nu app, present at Soriana checkout. Limit: MX$5,000 per transaction. No card needed.
- **Ualá partnership:** October 2023. Free instant cash deposits at 1,000+ Soriana stores for Ualá customers.
- **Bill payments:** Standard utility and service bill collection.
- **Remittance pickup:** Available through various money transfer operators.

**Partnership Model:**
Soriana has been aggressive in partnering with fintechs. It uses the Arcus/tapi middleware. The Nu partnership was described as: "customers generate a unique code from the Nu app, which the store cashier uses to transfer funds into the corresponding Nu Account. A barcode is also generated that can be scanned directly from the app."

**Velo Relevance:**
Soriana is one of the more accessible partners for cash deposit integration. It already has the technical middleware in place (tapi/Arcus) and a track record of working with multiple fintechs.

---

### 1.5 Chedraui

| Metric         | Value                                           |
| -------------- | ----------------------------------------------- |
| Head office    | Xalapa, Veracruz, Mexico                        |
| Stores         | 1,000+ (across Mexico and US Southwest)         |
| Store brands   | Chedraui, Súper Chedraui, Súper Che, Supercitos |
| Annual revenue | ~$263B MXN in 2023                              |

**Services Offered:**

- **Cash deposits/withdrawals:** Available through Arcus/tapi network. Limit: MX$10,000 per transaction.
- **Bill payments:** Standard services.
- **Nu partnership:** Chedraui was part of Nu's initial cash network (alongside Soriana, Kiosko, Systienda, Yastás, and Financiera para el Bienestar).

**Key Differentiator:**
Chedraui is particularly strong in southern Mexico and less-served regions, making it strategically important for financial inclusion use cases.

**Velo Relevance:**
Available through tapi aggregator. Likely an easier direct partnership than OXXO or Walmart, given their existing pattern of working with fintechs.

---

### 1.6 Telecomm (Financiera para el Bienestar / Telecomunicaciones de México)

| Metric   | Value                                                                                |
| -------- | ------------------------------------------------------------------------------------ |
| Type     | Government agency (Secretariat of Infrastructure, Communications and Transportation) |
| Branches | ~1,200+ across Mexico                                                                |
| Services | Cash pickups, bill payments, banking, satellite communications                       |

**Services Offered:**

- **Remittance cash pickup:** Major partner for international remittances (Western Union, MoneyGram, Félix Pago, Sharemoney, Remitbee).
- **Bank deposits:** Deposits to BBVA, Banamex, Santander, Banorte, HSBC, Scotiabank, Inbursa. Commission: MX$15-50 depending on branch type.
- **Social program disbursements:** Government welfare payments distributed through Telecomm branches.
- **Transaction limits:** Via Rapyd — up to MX$10,000 per transaction.

**Key Differentiator:**
Telecomm reaches rural and remote areas where commercial retailers have no presence. It's the government's financial inclusion arm. Works with 7 major banks.

**Velo Relevance:**
Important for rural coverage. Partnership terms may be more flexible (government mandate for financial inclusion). Available through tapi and Rapyd aggregators.

---

### 1.7 Circle K / Extra

| Metric           | Value                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| Parent           | Alimentation Couche-Tard (Canada)                                         |
| Stores in Mexico | ~750+ (Circle K + Extra brands)                                           |
| Notable          | First major convenience chain to adopt CoDi (Banxico's QR payment system) |

**Services Offered:**

- **Cash deposits:** Bank deposits at Circle K and Extra stores.
- **CoDi payments:** Adopted Banxico's CoDi QR payment system in June 2024 (via STP and dapp).
- **Bill payments:** Standard utilities and services.
- **Transaction limits:** MX$10,000 per transaction (via Rapyd network).
- **Mercado Pago network:** Included in Mercado Pago's 45,000+ cash-in/cash-out access points.

**Velo Relevance:**
Smaller network but growing. Adoption of CoDi shows willingness to adopt modern payment infrastructure. Accessible through tapi and Mercado Pago's network.

---

## 2. Partnership Requirements

### 2.1 Technical Requirements

**The Middleware Layer (Critical Infrastructure)**

The most important technical reality is that **no major Mexican retailer runs custom integrations for each fintech partner**. Instead, they work through middleware aggregators:

| Aggregator                        | Network Coverage                                                                      | Key Clients                            |
| --------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| **tapi** (post-Arcus acquisition) | OXXO, 7-Eleven, Chedraui, Soriana, Walmart, Telecomm, Circle K, + billers             | Mercado Pago, Nubank, Stori, DollarApp |
| **Rapyd**                         | 7-Eleven, OXXO, Walmart, Soriana, Chedraui, Circle K, Telecomm, Farmacias, +25 others | Global merchants, e-commerce           |
| **EBANX**                         | OXXO, 7-Eleven, Soriana, Walmart                                                      | International merchants                |
| **dLocal**                        | OXXO, 7-Eleven, banks                                                                 | Cross-border merchants                 |

**Integration Architecture (tapi example):**

```
Velo API -> tapi API -> Retailer POS Systems
                |
           SPEI Settlement
                |
           Billing/Reconciliation
```

- **Single API integration:** Fintechs integrate once with tapi; tapi handles connections to all retailers.
- **Reference/code generation:** The fintech app generates a unique reference number or barcode; the customer presents this at the store.
- **Real-time notification:** The retailer's POS confirms payment; tapi sends real-time callback to the fintech.
- **Settlement:** Typically T+1 to T+3 via SPEI (Mexico's real-time interbank payment system). Tapi handles reconciliation.
- **Transaction limits:** Vary by retailer (range: MX$5,000 to MX$215,000 depending on retailer and service). See Rapyd's documentation for exact limits per partner.

**Technical Requirements for Velo:**

1. **REST API integration** with middleware provider (tapi, Rapyd, etc.)
2. **Barcode/QR generation** capability for in-store reference codes
3. **Webhook handling** for payment confirmation callbacks
4. **SPEI integration** (optional if tapi handles settlement) for MXN fund flows
5. **MXN stablecoin or fiat on-ramp** for the Stellar side — cash collected in MXN must convert to Velo's settlement currency
6. **KYC/AML compliance** at onboarding to meet Mexican regulations

### 2.2 Commercial Requirements

**Fee Structures (Estimated):**

| Partner  | Typical Fee                         | Settlement |
| -------- | ----------------------------------- | ---------- |
| OXXO     | 2-4% per transaction via aggregator | T+1 to T+3 |
| 7-Eleven | 2-4% via aggregator                 | T+1 to T+3 |
| Walmart  | Varies; higher for direct deals     | Negotiable |
| Soriana  | 1.5-3% via aggregator               | T+1 to T+2 |
| Chedraui | 1.5-3% via aggregator               | T+1 to T+2 |
| Telecomm | Lower fees (government mandate)     | T+1        |

**Indicative Aggregator Pricing:**

- **tapi:** Per-transaction fee (estimated 2-4% of transaction value). May also charge monthly platform fee. Series B backed by Kaszek and a16z; focused on volume growth.
- **Rapyd:** Higher fees (3-5%) but broader international coverage. Suitable for cross-border use cases.
- **Volume commitments:** Most aggregators require minimum monthly volumes, especially for cash-in/cash-out services.
- **Settlement currency:** Typically MXN. Velo would need to handle MXN-to-stablecoin conversion.

**Business Model Considerations:**

| Factor                           | Impact for Velo                                                 |
| -------------------------------- | --------------------------------------------------------------- |
| Aggregator fees (2-4%)           | Must be absorbed or passed to merchants                         |
| Settlement time (2-3 days)       | Velo may need to front liquidity for instant settlement promise |
| Currency conversion (MXN → USDC) | Two spreads: aggregator's FX rate + Stellar conversion cost     |
| Minimum volumes                  | Likely negotiation point with tapi                              |

### 2.3 Regulatory Requirements

**Mexico's Fintech Law (Ley para Regular las Instituciones de Tecnología Financiera — LRITF):**

Enacted in 2018, significantly amended in 2024-2025 ("Fintech Law 2.0"). Key provisions:

| Requirement                                            | Details                                                                                                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IFPE License** (Electronic Payment Fund Institution) | Required to issue or manage e-money in Mexico. Minimum capital requirements. Processing time: ~416-781 days (per Legal Paradox data). 89 authorized institutions as of 2026. |
| **Registration with CNBV**                             | Comisión Nacional Bancaria y de Valores — primary fintech regulator                                                                                                          |
| **Registration with Banxico**                          | Central bank regulates payment systems (SPEI, CoDi)                                                                                                                          |
| **AML Compliance**                                     | Must comply with Mexico's anti-money laundering law (Ley Federal para la Prevención e Identificación de Operaciones con Recursos de Procedencia Ilícita)                     |
| **Data Privacy**                                       | Must comply with Ley Federal de Protección de Datos Personales                                                                                                               |
| **Open Banking APIs**                                  | Fintech law mandates API sharing for account aggregation (if licensed)                                                                                                       |
| **Llave MX**                                           | New national digital ID platform (2025 reforms)                                                                                                                              |
| **Stablecoin rules**                                   | 2025 reforms introduced stablecoin reserve requirements for MXN-pegged tokens                                                                                                |

**Does Velo need a Mexican license?**

| Scenario                                                                                     | License Required?                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Velo contracts with tapi (aggregator handles cash-in)                                        | Possibly not — tapi is the regulated entity                  |
| Velo opens Mexican entity, hires local team                                                  | Corporate registration (RFC) required                        |
| Velo holds client funds in Mexico                                                            | IFPE license likely required                                 |
| Velo issues stablecoins pegged to MXN                                                        | Full IFPE or banking license required                        |
| Velo only provides Stellar infrastructure to Mexican partners, no direct customer onboarding | Likely no license needed — tapi handles regulated activities |

**Critical Note:** If Velo partners with tapi, tapi is the regulated entity (post-Arcus acquisition, tapi operates through Mastercard's existing Mexican payment infrastructure licenses). This significantly reduces regulatory burden.

---

## 3. Feasibility Assessment

### 3.1 The tapi Factor

The June 2025 acquisition of Arcus by tapi is the single most important recent event in Mexican cash payments. It means:

- **Before:** Fintechs had to negotiate separately with Mastercard (Arcus) for retail access.
- **Now:** Tapi owns the middleware layer directly. It's a startup — potentially more responsive, more API-first.
- **Scale:** Tapi processes ~25 million monthly transactions in Mexico, supports 110+ clients, and expects to process $5.5B in 2025.
- **Funding:** $32M total raised (Kaszek, a16z). Profitable. This was an all-cash acquisition funded from operations.
- **Strategy:** Tapi specializes in recurring payments and cash transactions. Their TapiPay product automates recurring collections end-to-end through a single API.

**Implication for Velo:** Tapi is the ideal partner. A single integration gives Velo access to the full Mexican retail cash network. Tapi's API-first approach aligns with Velo's technology stack.

### 3.2 Market Size Opportunity

| Metric                      | Value                      | Source             |
| --------------------------- | -------------------------- | ------------------ |
| Cash transactions in Mexico | $315B of $476B total (66%) | Rebill, 2022 data  |
| e-commerce cash payments    | $6B (10% of online)        | Rebill             |
| OXXO Pay volume             | ~$6B annually              | Industry estimates |
| Unbanked adults             | 42% of adult population    | INEGI/CNBV         |
| Fintech startups            | 1,104+ (2025)              | Finnovista         |
| Mercado Pago cash network   | 45,000+ access points      | Mercado Pago       |
| Cash logistics CAGR         | 8.69% (2025-2030)          | Bonafide Research  |

### 3.3 Competitive Landscape

**Players already integrating Stellar / blockchain with cash:**

| Company          | Approach                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| **MoneyGram**    | Direct Stellar partner for USDC settlement. Has cash-in/cash-out in Mexico via retail partners. |
| **Félix Pago**   | WhatsApp-based remittances. Payouts via OXXO, Walmart, Soriana, 7-Eleven, +40,000 locations.    |
| **Mercado Pago** | Largest cash-in/out network in Mexico. 45,000+ points. Not Stellar-native.                      |

**Stellar-specific consideration:** MoneyGram's Stellar integration means there is already infrastructure for USDC-to-cash in Mexico. However, MoneyGram's retail partner network in Mexico (~16,000 locations) is smaller than what's available through tapi.

### 3.4 Key Risks

| Risk                                                           | Severity | Mitigation                                                  |
| -------------------------------------------------------------- | -------- | ----------------------------------------------------------- |
| Heavy aggregator fees (2-4%)                                   | Medium   | Volume pricing negotiation; pass-through to merchants       |
| Settlement delay (T+2/3)                                       | Medium   | Velo may need to front liquidity                            |
| Regulatory change                                              | Medium   | Work through licensed partner (tapi)                        |
| Competitor threat (Mercado Pago, Nubank building own networks) | High     | Focus on Stellar's unique value (speed, cost, cross-border) |
| OXXO/FEMSA building Spin as a full bank                        | Medium   | Delay in banking license application per 2025 annual report |
| Currency volatility (MXN/USD)                                  | Low      | Stablecoin layer mitigates; SPEI settlement in MXN          |

---

## 4. Recommendations

### 4.1 Immediate Actions (0-3 months)

1. **Open commercial discussions with tapi.** They are the single most important partner in Mexico. As a startup (not a large corporation), they may be more flexible. Present Velo's Stellar-based payment infrastructure as complementary — tapi handles the cash-in; Velo handles the blockchain settlement and merchant payouts.

2. **Evaluate regulatory posture.** Engage a Mexican fintech law firm (e.g., Legal Paradox, Pérez-Llorca) to determine whether Velo needs an IFPE license or can operate through tapi's licensed infrastructure. Budget: ~$50-100K for legal and setup.

3. **Assess the MoneyGram overlap.** MoneyGram already has Stellar integration and a Mexican cash network (~16,000 locations). Determine whether extending the existing MoneyGram-Stellar pipeline is faster than building a new tapi integration.

### 4.2 Medium-Term Actions (3-9 months)

4. **Integrate with tapi API.** If commercial terms are acceptable, integrate Velo's Stellar payouts with tapi's cash-in/cash-out API. This would enable:
   - Mexican merchants funded in USDC via Stellar
   - End-users depositing cash at any OXXO/7-Eleven/Soriana/Chedraui
   - Settlement to Velo's Mexican entity in MXN (via SPEI) or USDC (via Stellar)

5. **Consider the Spin by OXXO partnership.** FEMSA's Spin platform is expanding its own financial services. Velo could potentially partner with Spin directly for a deeper integration, though this is more complex than the tapi route.

6. **Evaluate Soriana/Chedraui direct.** These mid-tier retailers have shown willingness to partner with fintechs. Direct partnerships could reduce per-transaction costs vs. aggregator fees.

### 4.3 Long-Term Strategic Considerations (9-18 months)

7. **IFPE license application.** If Velo expects significant volume in Mexico, apply for an Electronic Payment Fund Institution license. This enables holding client funds and issuing e-money. Processing takes 12-24 months.

8. **Build for the "cash-to-crypto" use case.** Mexico is a major remittance receiver (~$63B in 2023). The combination of Velo's Stellar rails + tapi's cash network creates a powerful corridor: US → USDC → Stellar → MXN → cash pickup at any Mexican retailer. This competes directly with traditional remittance.

9. **Watch Walmart/BAIT/Cashi.** Walmart is building its own financial ecosystem. If they become a direct competitor (like Mercado Pago), Velo needs to be either partnered with them or differentiated enough to not need them.

### 4.4 Recommended Partner Priority

| Tier        | Partners                                           | Rationale                                                            |
| ----------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| **Tier 1**  | tapi → OXXO, 7-Eleven, Chedraui, Soriana, Telecomm | Single integration, maximum coverage                                 |
| **Tier 2**  | MoneyGram existing Stellar pipeline                | Already connected, proven Stellar integration                        |
| **Tier 3**  | Direct: Soriana, Chedraui                          | Potential for better economics                                       |
| **Monitor** | Walmart/Cashi, Spin by OXXO                        | Both are potential competitors; evaluate partnership vs. competition |

---

## Appendix A: Transaction Limits by Partner (from Rapyd Network)

| Retailer                                                   | Max per Transaction (MXN) |
| ---------------------------------------------------------- | ------------------------- |
| Santander, Scotiabank, Banco Azteca, HSBC, Afirme, Banorte | 215,000                   |
| BBVA                                                       | 199,000                   |
| Walmart, Walmart Express, Sam's Club, Bodega Aurrera       | 30,000                    |
| Farmacias del Ahorro, 7-Eleven, Farmacias Benavides        | 15,000                    |
| Circle K, Extra, Chedraui, Telecomm, Soriana               | 10,000                    |
| Waldos                                                     | 5,000                     |

## Appendix B: Key Regulatory Bodies

| Body                                                | Role                                                |
| --------------------------------------------------- | --------------------------------------------------- |
| **CNBV** (Comisión Nacional Bancaria y de Valores)  | Primary fintech regulator; issues IFPE/IFC licenses |
| **Banxico** (Banco de México)                       | Central bank; regulates SPEI, CoDi, payment systems |
| **SHCP** (Secretaría de Hacienda y Crédito Público) | Finance Ministry; sets fintech policy               |
| **CONDUSEF**                                        | Consumer financial protection                       |
| **SAT** (Servicio de Administración Tributaria)     | Tax authority                                       |

## Appendix C: Cash Fact Summary (Mexico)

- ~42% of adults are unbanked
- ~70% lack credit cards
- 66-88% of transactions involve cash
- Mexico received ~$63B in remittances (2023)
- 73% of adults made an SPEI transfer in 2024 (up YoY)
- Cash withdrawals down 2.4% YoY (3rd consecutive year of decline) — cash is declining but remains dominant
- 1,100+ fintech startups in Mexico (2025)
- 89 authorized Financial Technology Institutions (IFPEs + IFCs)
