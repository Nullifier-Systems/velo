/**
 * Single source of truth for deployed contract addresses.
 * apps/api, mobile/backend, and mobile/frontend all import from here —
 * never hardcode a contract address in app code.
 *
 * Stellar Mainnet USDC issuer:
 *   GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN (Circle)
 *
 * USDC on Stellar is a classic asset (not a Soroban token) unless wrapped.
 * For Soroban contracts the token address is the Stellar Asset Contract (SAC)
 * address, which is deterministic:  https://github.com/stellar/stellar-protocol/blob/master/core/cap-0046.md
 *
 * The SAC address for USDC on mainnet is:
 *   CCW67TSZV3SSWZ6NAU4B46GSAV4IX3ODU6OVU5Q2ZWCEO6PJ6W7JXK2O
 * (derived from the USDC classic asset descriptor via the SAC factory).
 *
 * ⚠️ Placeholder values below — replace with real deployed contract IDs
 *    AFTER the mainnet deployment transaction succeeds (step 4 of the
 *    go-live checklist in docs/mainnet-deployment.md).
 */
export const CONTRACTS = {
  testnet: {
    escrow: 'CAEYSVTKTCZYTSMPD7CU3NOFYOO4S5V6LJLGRNV7LKTNZ65N66PCHLMC',
    atomicSwapA: 'SET_ME_AFTER_FIRST_DEPLOY',
    zkVerifierRegistry: 'SET_ME_AFTER_FIRST_DEPLOY',
  },
  mainnet: {
    escrow: 'DEPLOY_ESCROW_FIRST',
    atomicSwapA: 'DEPLOY_ATOMIC_SWAP_FIRST',
    zkVerifierRegistry: '',
  },
} as const;

/** Stellar Mainnet USDC metadata */
export const USDC_MAINNET = {
  issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  /** Stellar Asset Contract address for USDC on mainnet */
  sac: 'CCW67TSZV3SSWZ6NAU4B46GSAV4IX3ODU6OVU5Q2ZWCEO6PJ6W7JXK2O',
  code: 'USDC',
} as const;

export type Network = keyof typeof CONTRACTS;

export interface CashRequest {
  id: string;
  claim_url: string;
  qr_payload: string;
  status: 'pending' | 'locked' | 'released' | 'refunded';
}
