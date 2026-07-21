# GrantFox USDC bounty payouts: tax and reporting research summary

**Issue:** [#78](https://github.com/Nullifier-Systems/velo/issues/78)  
**Status:** Research summary only — **not legal or tax advice**  
**Date:** 2026-07-20  
**Purpose:** Help Nullifier Systems decide whether professional tax counsel is needed for GrantFox / USDC contributor payouts.

---

## 1. Scope and assumptions

This note covers common questions for:

1. **Contributors** who receive USDC (or similar stablecoin) bounty rewards via GrantFox for open-source work.
2. **Payers** (e.g. Nullifier Systems / campaign operators) who send those rewards.

Jurisdiction is **not fixed** in the issue. Rules differ heavily by country (US, EU member states, Kenya, etc.). Below prioritizes **US federal** framing because most OSS bounty docs and IRS crypto guidance are US-centric, then flags international caveats.

Treat every section as a **research pointer**, not a determination of liability.

---

## 2. Contributor side (receiving USDC)

### 2.1 Income characterization (typical US framing)

| Question                               | Research direction                                                                                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is USDC a “taxable unit”?              | US IRS treats virtual currency as **property** for federal tax purposes (Notice 2014-21 lineage; later FAQs). Receiving crypto for services is generally **income** measured at FMV in USD at receipt.                                                                           |
| Is a bounty “wages” or “other income”? | Absent employment: often **self-employment / other income** for services, not wages. Employment classification is facts-and-circumstances (control, integration, tools). GrantFox-style OSS bounties usually look like **independent contractor / freelance** work, not payroll. |
| When is income recognized?             | Typically when the contributor has **dominion and control** over the USDC (credited to their wallet / claimable and withdrawable), not when the issue is opened.                                                                                                                 |
| Basis for later disposal               | FMV at receipt becomes **cost basis** for capital gain/loss if later sold or swapped.                                                                                                                                                                                            |

### 2.2 Self-employment and reporting (US research flags)

- Self-employed individuals may owe **income tax + self-employment tax** on net earnings from services if thresholds apply.
- Forms often discussed in secondary sources: **Schedule C** (business income), **Schedule SE**, and annual return. Exact forms depend on facts.
- **1099 series:** payers may issue information returns in some cases; absence of a form does **not** mean the income is non-taxable.
- Recordkeeping: date received, USD FMV source (exchange rate at receipt), tx hash, bounty issue URL, wallet address used.

### 2.3 Non-US contributors

- Many jurisdictions tax worldwide income for residents; crypto-for-services often still taxable locally.
- VAT/GST on digital services can apply in some countries for B2B/B2C cross-border work.
- Treaty benefits (if any) require residency analysis and forms — out of scope here.

---

## 3. Payer side (Nullifier Systems / GrantFox campaign operator)

### 3.1 Are bounty payments deductible?

Possible business expense if ordinary and necessary for a trade or business (marketing, R&D, community, product development). Classification depends on entity type and books. **Not automatic.**

### 3.2 Information reporting (US research flags)

US payers of non-employee compensation have long used **Form 1099-NEC** (or historically 1099-MISC) when payments to a US person exceed annual thresholds **and** other conditions are met (TIN collection, not corporations in some cases, etc.).

Crypto-specific reporting is evolving:

- Broker / digital asset reporting rules (e.g. expanded 1099-DA style regimes) target **brokers and certain platforms**, not every OSS maintainer.
- Paying USDC from a protocol treasury or ops wallet may **not** automatically make Nullifier a “broker,” but **contractor-style service payments** can still trigger classic non-employee compensation reporting if thresholds and payee status are met.

**Practical research conclusion:**  
If Nullifier Systems systematically pays US persons ≥ threshold amounts for discrete work product, they should evaluate **W-9 collection, 1099-NEC obligations, and backup withholding** with a CPA. If payees are non-US, **W-8BEN / chapter 3 & 4 withholding** analysis may apply instead.

### 3.3 AML / sanctions (separate from tax)

Even when tax is light, senders should avoid sanctioned persons/jurisdictions (OFAC etc.). This is compliance risk adjacent to “reporting,” not a substitute for tax counsel.

### 3.4 GrantFox as intermediary

If GrantFox (or Stellar rails) is the **technical payout rail** but Nullifier is the economic payer:

- Determine who is the **legal payor of record**.
- Platform terms may allocate KYC, tax forms, or “user responsible for taxes” language — review GrantFox TOS and campaign agreements.
- Intermediate platforms sometimes handle collector forms; do not assume they do without reading current docs.

---

## 4. What this research does _not_ decide

- Exact tax owed by any contributor or by Nullifier Systems.
- Whether GrantFox auto-issues 1099s in 2026.
- State/local US tax, EU DAC8/MiCA reporting, or Kenya/other local rules.
- Employment vs contractor classification for any named individual.
- Token vs stablecoin accounting differences beyond FMV-at-receipt.

---

## 5. Recommended next steps (operational, not legal advice)

| Priority | Action                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| High     | Retain a CPA / tax counsel familiar with crypto service payments in Nullifier’s home jurisdiction.                          |
| High     | Document each payout: amount, asset, USD FMV, date, txid, issue/PR link, payee wallet.                                      |
| Medium   | Add contributor FAQ: “You are responsible for taxes in your jurisdiction; this is not employment.” (non-advice disclaimer). |
| Medium   | If paying US persons regularly: process for W-9 / TIN and 1099 review before year-end.                                      |
| Medium   | If paying non-US: W-8 / residency workflow review.                                                                          |
| Low      | Monitor IRS digital asset broker rules and GrantFox platform tax features quarterly.                                        |

---

## 6. Sources to re-verify live (do not treat as frozen law)

- IRS Notice 2014-21 and subsequent virtual currency FAQs (irs.gov).
- IRS Form 1099-NEC instructions (current year).
- IRS digital asset / broker reporting pages (rules change).
- GrantFox documentation and terms of service (grantfox.xyz / campaign docs).
- Stellar / USDC issuer compliance notes (Circle, etc.) only as payment-rail context.

---

## 7. Bottom line for #78

1. **Contributors:** Research consensus is that crypto received for OSS bounty work is often **taxable income at FMV on receipt** in the US; other countries vary. Keep records.
2. **Nullifier Systems:** May have **business-expense and information-reporting** questions if systematically paying people for services; not automatically “no obligations” just because the asset is USDC on Stellar.
3. **This document is insufficient for compliance.** Budget professional review before mainnet-scale GrantFox payout volume.

_Prepared for Velo / Nullifier Systems open research. Not a substitute for licensed advice._
