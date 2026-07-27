import { ethers } from "ethers";

/** Minimal ABI for the counterpart HTLC (contracts-evm/HTLC.sol). */
export const HTLC_ABI = [
  "function newSwap(bytes32 hashlock, address recipient, uint256 timelock) payable",
  "function submitAttestation(bytes32 secret)",
  "function withdraw(bytes32 secret)",
  "function refund(bytes32 hashlock)",
  "function hashOf(bytes32 secret) view returns (bytes32)",
  "function threshold() view returns (uint256)",
  "function relayerCount() view returns (uint256)",
  "function attestationCount(bytes32 hashlock) view returns (uint256)",
  "function isRelayer(address) view returns (bool)",
  "event Withdrawn(bytes32 indexed hashlock, bytes32 secret)",
  "event Attested(bytes32 indexed hashlock, address indexed relayer, uint256 attestationCount)",
];

/**
 * The single operation the relayer performs on the EVM leg: reveal the secret
 * to claim the counterpart HTLC via threshold attestation. Abstracted behind an interface
 * so the orchestrator can be unit-tested without a live EVM node.
 */
export interface EvmHtlcClient {
  /** Submit `submitAttestation(secret)` or `withdraw(secret)` and resolve with tx hash. */
  withdraw(secretHex: string): Promise<string>;
  /** Explicit threshold attestation submission. */
  submitAttestation?(secretHex: string): Promise<string>;
}

/** ethers-backed {@link EvmHtlcClient} for a real EVM testnet/mainnet. */
export class EthersEvmHtlcClient implements EvmHtlcClient {
  private readonly contract: ethers.Contract;

  constructor(rpcUrl: string, privateKey: string, htlcAddress: string) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    this.contract = new ethers.Contract(htlcAddress, HTLC_ABI, wallet);
  }

  async submitAttestation(secretHex: string): Promise<string> {
    const tx = await this.contract.submitAttestation(secretHex);
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }

  async withdraw(secretHex: string): Promise<string> {
    return this.submitAttestation(secretHex);
  }
}
