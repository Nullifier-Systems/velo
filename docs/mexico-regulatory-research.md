# Regulatory Requirements for Cash-Exchange Operation in Mexico

**Disclaimer**: This document is a research summary intended to inform technical and operational planning. It does not constitute formal legal advice.

## 1. Overview of Mexican Fintech Regulation

The primary regulatory framework in Mexico is the **Financial Technology Institutions Law** (Ley para Regular las Instituciones de Tecnología Financiera, or "Ley Fintech"), overseen by the National Banking and Securities Commission (CNBV) and the central bank (Banxico).

The law establishes two main licensing categories:
1. **IFPE (Instituciones de Fondos de Pago Electrónico)**: Entities that issue, manage, or operate electronic payment funds (e-wallets, fiat custodians).
2. **IFC (Instituciones de Financiamiento Colectivo)**: Crowdfunding institutions.

Additionally, the **Anti-Money Laundering Law** (LFPIORPI) designates the habitual exchange of "Virtual Assets" (cryptocurrencies) as a "Vulnerable Activity," requiring registration with the tax authority (SAT) and adherence to strict AML/KYC reporting protocols.

## 2. Analysis of Velo's Model

Velo operates a **peer-to-peer, non-custodial escrow model** where users match with cash providers to exchange stablecoins for physical MXN.

### Is Velo an IFPE?
Likely **No**. An IFPE license is typically required when a company holds users' fiat money or issues its own electronic balances representing fiat. Because Velo:
- Does not hold user fiat (cash changes hands directly between peers).
- Does not custody crypto (stablecoins are locked in decentralized smart contracts).
It operates closer to a software bulletin board or decentralized matching engine rather than a financial custodian.

### Is Velo a Virtual Asset Service Provider (VASP)?
This is the main area of regulatory friction. Under LFPIORPI, offering services to facilitate the exchange of virtual assets is a "vulnerable activity."
- While Velo is non-custodial, it provides the UI, the matching engine, and the smart contract infrastructure facilitating the trade. 
- Mexican regulators (CNBV/Banxico/SAT) have historically taken a broad view of what constitutes facilitating crypto transactions. Even non-custodial matching platforms may be required to register with the SAT to fulfill AML obligations.

## 3. Compliance Steps for Mainnet Operation

Before launching real mainnet operations in Mexico, Velo should consider the following compliance roadmap:

### Step 1: Formal Legal Classification
- Obtain a formal legal opinion from Mexican Fintech counsel to confirm that Velo's non-custodial, smart-contract-based escrow exempts it from requiring an IFPE license from the CNBV.
- Determine exactly where Velo falls under the LFPIORPI (AML law) given that it facilitates trades but never touches the assets.

### Step 2: KYC & AML Integration
- If Velo is deemed a facilitator of a "vulnerable activity," it must integrate identity verification (KYC).
- Mexican law defines specific transaction thresholds (measured in UMA - Unidades de Medida y Actualización). 
  - Trades below a certain threshold may require basic identification.
  - Trades above a higher threshold require formal reporting to the authorities.
- The platform architecture must support collecting and securely storing KYC data before users are permitted to interact with the matching engine.

### Step 3: Terms of Service and Risk Disclosures
- Draft Terms of Service clearly defining Velo as a non-custodial software provider, not a financial institution, bank, or currency exchange.
- Include mandatory risk disclosures regarding the peer-to-peer exchange of cash, indemnifying Velo from physical security risks associated with the in-person cash handoff.

### Step 4: Cash Provider Onboarding
- Ensure that the "Cash Providers" (liquidity providers) are aware of their own tax and AML obligations, as frequent, high-volume trading of cash for crypto could flag them as professional operators under Mexican law.

## Conclusion
Velo's non-custodial nature is a massive regulatory advantage, likely avoiding the multi-year, multi-million dollar process of obtaining an IFPE license. However, the platform cannot completely bypass AML (LFPIORPI) obligations. Implementing modular KYC and clearly defining the platform's non-custodial legal boundaries are the critical next steps for a Mexico launch.
