import { ethers } from "ethers";

/** Minimal ABI for the counterpart HTLC (contracts-evm/HTLC.sol). */
export const HTLC_ABI = [
  "function newSwap(bytes32 hashlock, address recipient, uint256 timelock) payable",
  "function withdraw(bytes32 secret)",
  "function refund(bytes32 hashlock)",
  "function hashOf(bytes32 secret) view returns (bytes32)",
  "event Withdrawn(bytes32 indexed hashlock, bytes32 secret)",
];

/**
 * The single operation the relayer performs on the EVM leg: reveal the secret
 * to claim the counterpart HTLC. Abstracted behind an interface so the
 * orchestrator can be unit-tested without a live EVM node.
 */
export interface EvmHtlcClient {
  /** Submit `withdraw(secret)` and resolve with the transaction hash. */
  withdraw(secretHex: string): Promise<string>;
}

/** ethers-backed {@link EvmHtlcClient} for a real EVM testnet/mainnet. */
export class EthersEvmHtlcClient implements EvmHtlcClient {
  private readonly contract: ethers.Contract;

  constructor(rpcUrl: string, privateKey: string, htlcAddress: string) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    this.contract = new ethers.Contract(htlcAddress, HTLC_ABI, wallet);
  }

  async withdraw(secretHex: string): Promise<string> {
    const tx = await this.contract.withdraw(secretHex);
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }
}
