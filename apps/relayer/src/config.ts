import { CONTRACTS } from "@velo/shared";

export interface RelayerConfig {
  stellarNetwork: string;
  sorobanRpcUrl: string;
  sorobanContractId: string;
  startLedger?: number;
  pollIntervalMs: number;
  evmRpcUrl: string;
  evmPrivateKey: string;
  evmHtlcAddress: string;
  relayerId: string;
  relayerThreshold: number;
  relayerTotal: number;
}

/**
 * Loads relayer config from the environment. Throws early (fail-fast) if a
 * value required to actually run is missing, so misconfiguration surfaces at
 * startup rather than mid-swap.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const sorobanContractId =
    env.RELAYER_SOROBAN_CONTRACT_ID?.trim() || CONTRACTS.testnet.atomicSwapA;

  const cfg: RelayerConfig = {
    stellarNetwork: env.STELLAR_NETWORK?.trim() || "TESTNET",
    sorobanRpcUrl: env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org",
    sorobanContractId,
    startLedger: env.RELAYER_START_LEDGER ? Number(env.RELAYER_START_LEDGER) : undefined,
    pollIntervalMs: env.RELAYER_POLL_INTERVAL_MS ? Number(env.RELAYER_POLL_INTERVAL_MS) : 5000,
    evmRpcUrl: env.EVM_RPC_URL?.trim() || "",
    evmPrivateKey: env.EVM_PRIVATE_KEY?.trim() || "",
    evmHtlcAddress: env.EVM_HTLC_ADDRESS?.trim() || "",
    relayerId: env.RELAYER_ID?.trim() || "relayer-1",
    relayerThreshold: env.RELAYER_THRESHOLD ? Number(env.RELAYER_THRESHOLD) : 2,
    relayerTotal: env.RELAYER_TOTAL ? Number(env.RELAYER_TOTAL) : 3,
  };
  return cfg;
}

/** Validates that the config is complete enough to run against live chains. */
export function assertRunnable(cfg: RelayerConfig): void {
  const missing: string[] = [];
  if (!cfg.sorobanContractId || cfg.sorobanContractId.startsWith("SET_ME")) {
    missing.push("RELAYER_SOROBAN_CONTRACT_ID");
  }
  if (!cfg.evmRpcUrl) missing.push("EVM_RPC_URL");
  if (!cfg.evmPrivateKey) missing.push("EVM_PRIVATE_KEY");
  if (!cfg.evmHtlcAddress) missing.push("EVM_HTLC_ADDRESS");
  if (missing.length > 0) {
    throw new Error(
      `relayer is missing required config: ${missing.join(", ")}. See apps/relayer/.env.example.`,
    );
  }
}
