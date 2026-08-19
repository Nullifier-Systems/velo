import { ethers } from "ethers";

/** ABI for the counterpart HTLC with Stake-Bonded Relayer Registry (contracts-evm/HTLC.sol). */
export const HTLC_ABI = [
  "function newSwap(bytes32 hashlock, address recipient, uint256 timelock) payable",
  "function submitAttestation(bytes32 secret)",
  "function withdraw(bytes32 secret)",
  "function refund(bytes32 hashlock)",
  "function hashOf(bytes32 secret) pure returns (bytes32)",
  "function threshold() view returns (uint256)",
  "function relayerCount() view returns (uint256)",
  "function totalActiveWeight() view returns (uint256)",
  "function totalActiveStake() view returns (uint256)",
  "function minRelayerStake() view returns (uint256)",
  "function unstakeDelayBlocks() view returns (uint256)",
  "function attestationCount(bytes32 hashlock) view returns (uint256)",
  "function attestedWeight(bytes32 hashlock) view returns (uint256)",
  "function isRelayer(address) view returns (bool)",
  "function relayers(address) view returns (address addr, uint256 stake, uint256 joinedBlock, uint256 lastAttestation, bool active)",
  "function getRelayer(address) view returns (tuple(address addr, uint256 stake, uint256 joinedBlock, uint256 lastAttestation, bool active))",
  "function stakeUnlock(address) view returns (uint256)",
  "function pendingUnstakeAmount(address) view returns (uint256)",
  "function joinRelayer(uint256 amount) payable",
  "function leaveRelayer()",
  "function withdrawStake()",
  "function slashRelayer(address relayer, uint256 penalty)",
  "function slashDoubleAttest(address relayer, bytes32 secret1, bytes32 secret2)",
  "event Locked(bytes32 indexed hashlock, address indexed sender, address indexed recipient, uint256 amount, uint256 timelock)",
  "event Withdrawn(bytes32 indexed hashlock, bytes32 secret)",
  "event Refunded(bytes32 indexed hashlock)",
  "event Attested(bytes32 indexed hashlock, address indexed relayer, uint256 attestationCount)",
  "event AttestedWeighted(bytes32 indexed hashlock, address indexed relayer, uint256 weight, uint256 totalAttestedWeight)",
  "event RelayerJoined(address indexed relayer, uint256 stake, uint256 weight)",
  "event RelayerLeft(address indexed relayer, uint256 unlockBlock, uint256 amount)",
  "event StakeWithdrawn(address indexed relayer, uint256 amount)",
  "event RelayerSlashed(address indexed relayer, uint256 penalty, address indexed treasury)",
  "event RelayersUpdated(uint256 threshold, uint256 relayerCount)",
];

export interface RelayerInfo {
  addr: string;
  stake: bigint;
  joinedBlock: bigint;
  lastAttestation: bigint;
  active: boolean;
}

/**
 * Interface for interactions with the EVM counterpart HTLC contract.
 */
export interface EvmHtlcClient {
  /** Submit `submitAttestation(secret)` or `withdraw(secret)` and resolve with tx hash. */
  withdraw(secretHex: string): Promise<string>;
  /** Explicit threshold attestation submission. */
  submitAttestation?(secretHex: string): Promise<string>;
  /** Stake and join the relayer consensus registry. */
  joinRelayer?(stakeAmount?: bigint): Promise<string>;
  /** Unbond and initiate unstake delay. */
  leaveRelayer?(): Promise<string>;
  /** Withdraw unstaked funds after delay elapses. */
  withdrawStake?(): Promise<string>;
  /** Slash a relayer for misbehavior. */
  slashRelayer?(relayerAddress: string, penalty: bigint): Promise<string>;
  /** Slash a relayer with double-attestation evidence. */
  slashDoubleAttest?(relayerAddress: string, secret1: string, secret2: string): Promise<string>;
  /** Query relayer information. */
  getRelayerInfo?(relayerAddress: string): Promise<RelayerInfo>;
  /** Query stake balance of a relayer. */
  getStakeBalance?(relayerAddress: string): Promise<bigint>;
  /** Query current threshold weight needed to execute a claim. */
  getThreshold?(): Promise<bigint>;
  /** Query total active weight across all bonded relayers. */
  getTotalActiveWeight?(): Promise<bigint>;
  /** Query accumulated attested weight for a given hashlock. */
  getAttestedWeight?(hashlockHex: string): Promise<bigint>;
}

/** ethers-backed {@link EvmHtlcClient} for a real EVM testnet/mainnet. */
export class EthersEvmHtlcClient implements EvmHtlcClient {
  readonly contract: ethers.Contract;
  readonly wallet: ethers.Wallet;

  constructor(rpcUrl: string, privateKey: string, htlcAddress: string) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, provider);
    this.contract = new ethers.Contract(htlcAddress, HTLC_ABI, this.wallet);
  }

  async submitAttestation(secretHex: string): Promise<string> {
    const tx = await this.contract.submitAttestation(secretHex);
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }

  async withdraw(secretHex: string): Promise<string> {
    const tx = await this.contract.withdraw(secretHex);
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }

  async joinRelayer(stakeAmount?: bigint): Promise<string> {
    const minStake: bigint = await this.contract.minRelayerStake();
    const amount = stakeAmount ?? minStake;
    const tx = await this.contract.joinRelayer(amount, { value: amount });
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }

  async leaveRelayer(): Promise<string> {
    const tx = await this.contract.leaveRelayer();
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }

  async withdrawStake(): Promise<string> {
    const tx = await this.contract.withdrawStake();
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }

  async slashRelayer(relayerAddress: string, penalty: bigint): Promise<string> {
    const tx = await this.contract.slashRelayer(relayerAddress, penalty);
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }

  async slashDoubleAttest(relayerAddress: string, secret1: string, secret2: string): Promise<string> {
    const tx = await this.contract.slashDoubleAttest(relayerAddress, secret1, secret2);
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }

  async getRelayerInfo(relayerAddress: string): Promise<RelayerInfo> {
    const res = await this.contract.getRelayer(relayerAddress);
    return {
      addr: res.addr,
      stake: BigInt(res.stake.toString()),
      joinedBlock: BigInt(res.joinedBlock.toString()),
      lastAttestation: BigInt(res.lastAttestation.toString()),
      active: Boolean(res.active),
    };
  }

  async getStakeBalance(relayerAddress: string): Promise<bigint> {
    const info = await this.getRelayerInfo(relayerAddress);
    return info.stake;
  }

  async getThreshold(): Promise<bigint> {
    const t = await this.contract.threshold();
    return BigInt(t.toString());
  }

  async getTotalActiveWeight(): Promise<bigint> {
    const w = await this.contract.totalActiveWeight();
    return BigInt(w.toString());
  }

  async getAttestedWeight(hashlockHex: string): Promise<bigint> {
    const w = await this.contract.attestedWeight(hashlockHex);
    return BigInt(w.toString());
  }
}
