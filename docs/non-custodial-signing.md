# Non-Custodial Signing Approaches for Soroban

This document compares options for replacing the current testnet custodial shortcut (backend-held keys signing on behalf of users) with a true non-custodial signing architecture in the Velo project.

---

## Compared Approaches

### Approach 1: Server-Prepared Unsigned XDR + Client-Side Wallet Signing

In this flow, the API remains responsible for simulating, preparing, and assembling transactions (e.g., querying Soroban RPC for footprint and fees). However, instead of signing the transaction using a backend-held secret key, the API returns the base64-encoded **unsigned XDR** to the client.

1. **Transaction Request**: The client requests a state change (e.g., locking funds).
2. **Simulation & Building**: The server builds the transaction, simulates it using Soroban RPC, prepares the footprint, compiles it to an unsigned transaction, and returns the base64 XDR.
3. **Client Signing**: The frontend calls the user's web/mobile wallet (e.g., via **Freighter API** or **Stellar Wallet Kit**) to sign the XDR.
4. **Submission**: The signed XDR is returned to the API (or submitted directly by the client to Soroban RPC).

- **Pros**:
  - Simplest to implement. Compatible with existing standard escrow contracts.
  - Integrates seamlessly with all major Stellar wallets (Freighter, xBull, Lobstr, Albedo) and hardware wallets (Ledger).
- **Cons**:
  - Requires the user to have a browser extension or a wallet app installed. Bad UX on standard mobile browsers (Safari/Chrome) without a dedicated dApp browser.

---

### Approach 2: Passkey-based Smart Accounts (WebAuthn + Soroban Custom Signers)

Soroban contracts support custom signature verification, allowing developers to implement Account Abstraction (AA). Users generate a credential using device biometrics (Face ID, Touch ID, or Windows Hello) via the standard WebAuthn API. A smart contract wallet is deployed for the user, storing the public key.

1. **Transaction Request**: The client initiates a transaction.
2. **Signature Generation**: The browser prompts the user for biometrics, producing a cryptographic signature using the device's secure enclave (secp256r1 curve).
3. **Execution**: The signature is sent to the smart wallet contract on Soroban, which validates the signature natively and routes the instruction to the escrow contract.

- **Pros**:
  - Unparalleled UX for retail users: no browser extension, wallet app downloads, or seed phrases are needed.
  - Works natively on all modern mobile and desktop browsers.
- **Cons**:
  - Requires deploying smart contract wallets for every user, which incurs setup fees.
  - More complex contract architecture and transaction construction.

---

## Recommendation

For the immediate production milestone, we recommend **Approach 1 (Server-Prepared XDR + Client-Side Wallet Kit)**. It offers the fastest path to security and mainnet readiness with minimal smart contract changes.

For the long-term retail-focused roadmap (Velo Mobile), transitioning to **Approach 2 (Passkeys)** will provide the friction-free UX required for mainstream cash-in/cash-out adoption.

---

## Implementation Sketch (Wiring into `stellar.ts`)

Here is how the API in `apps/api/src/lib/stellar.ts` would be refactored to support Approach 1:

```typescript
import { BASE_FEE, TransactionBuilder, Operation } from '@stellar/stellar-sdk';
import { Server, assembleTransaction, Api } from '@stellar/stellar-sdk/rpc';

const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK === 'PUBLIC'
    ? 'Public Global Stellar Network ; October 2015'
    : 'Test SDF Network ; September 2015';

const server = new Server(RPC_URL);

/**
 * Prepares and simulates a contract invocation, returning the base64 unsigned XDR.
 */
export async function prepareInvokeXDR(
  sourcePublicKey: string,
  contractId: string,
  functionName: string,
  args: any[]
): Promise<string> {
  const account = await server.getAccount(sourcePublicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: functionName,
        args,
      })
    )
    .setTimeout(30)
    .build();

  // 1. Simulate to calculate resource fees and footprint
  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  // 2. Assemble simulation results into the prepared transaction
  const preparedTx = assembleTransaction(tx, sim).build();

  // 3. Return the base64-encoded transaction envelope (without signatures)
  return preparedTx.toXDR();
}

/**
 * Submits a client-signed transaction envelope to the Soroban RPC.
 */
export async function submitSignedXDR(signedXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sendResult = await server.sendTransaction(tx);
  if (sendResult.status === 'ERROR') {
    throw new Error(`submission failed: ${JSON.stringify(sendResult.errorResult)}`);
  }
  return sendResult.hash;
}
```
