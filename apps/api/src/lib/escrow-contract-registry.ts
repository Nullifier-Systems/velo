import { CONTRACTS } from "@velo/shared";

export const DEFAULT_SETTLEMENT_ASSET = "USDC";

export type EscrowDeploymentStatus = "active" | "draining" | "retired";

export interface EscrowContractDeployment {
  asset: string;
  contractId: string;
  version: string;
  status: EscrowDeploymentStatus;
}

export class EscrowRegistryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowRegistryConfigError";
  }
}

export class UnsupportedSettlementAssetError extends Error {
  readonly asset: string;

  constructor(asset: string) {
    super(`No active escrow contract is configured for settlement asset ${asset}`);
    this.name = "UnsupportedSettlementAssetError";
    this.asset = asset;
  }
}

export function normalizeSettlementAsset(asset: string): string {
  const normalized = asset.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]{0,63}$/.test(normalized)) {
    throw new EscrowRegistryConfigError(
      `Invalid settlement asset "${asset}"; use a 1-64 character asset identifier`,
    );
  }
  return normalized;
}

function parseDeployment(value: unknown, index: number): EscrowContractDeployment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EscrowRegistryConfigError(
      `ESCROW_CONTRACTS_JSON entry ${index} must be an object`,
    );
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.asset !== "string") {
    throw new EscrowRegistryConfigError(
      `ESCROW_CONTRACTS_JSON entry ${index} is missing asset`,
    );
  }
  if (typeof candidate.contractId !== "string" || !candidate.contractId.trim()) {
    throw new EscrowRegistryConfigError(
      `ESCROW_CONTRACTS_JSON entry ${index} is missing contractId`,
    );
  }
  if (typeof candidate.version !== "string" || !candidate.version.trim()) {
    throw new EscrowRegistryConfigError(
      `ESCROW_CONTRACTS_JSON entry ${index} is missing version`,
    );
  }
  if (
    candidate.status !== "active" &&
    candidate.status !== "draining" &&
    candidate.status !== "retired"
  ) {
    throw new EscrowRegistryConfigError(
      `ESCROW_CONTRACTS_JSON entry ${index} has an invalid status`,
    );
  }

  return {
    asset: normalizeSettlementAsset(candidate.asset),
    contractId: candidate.contractId.trim(),
    version: candidate.version.trim(),
    status: candidate.status,
  };
}

export class EscrowContractRegistry {
  private readonly deployments: readonly EscrowContractDeployment[];
  private readonly activeByAsset: ReadonlyMap<string, EscrowContractDeployment>;

  constructor(deployments: readonly EscrowContractDeployment[]) {
    if (deployments.length === 0) {
      throw new EscrowRegistryConfigError(
        "At least one escrow contract deployment must be configured",
      );
    }

    const seenContractIds = new Set<string>();
    const activeByAsset = new Map<string, EscrowContractDeployment>();

    this.deployments = deployments.map((deployment, index) => {
      const normalized = parseDeployment(deployment, index);
      if (seenContractIds.has(normalized.contractId)) {
        throw new EscrowRegistryConfigError(
          `Escrow contract ${normalized.contractId} is configured more than once`,
        );
      }
      seenContractIds.add(normalized.contractId);

      if (normalized.status === "active") {
        if (activeByAsset.has(normalized.asset)) {
          throw new EscrowRegistryConfigError(
            `Settlement asset ${normalized.asset} has more than one active escrow contract`,
          );
        }
        activeByAsset.set(normalized.asset, normalized);
      }
      return Object.freeze(normalized);
    });

    this.activeByAsset = activeByAsset;
  }

  resolve(asset: string): EscrowContractDeployment {
    const normalized = normalizeSettlementAsset(asset);
    const deployment = this.activeByAsset.get(normalized);
    if (!deployment) {
      throw new UnsupportedSettlementAssetError(normalized);
    }
    return deployment;
  }

  list(): readonly EscrowContractDeployment[] {
    return this.deployments;
  }

  listActive(): readonly EscrowContractDeployment[] {
    return this.deployments.filter((deployment) => deployment.status === "active");
  }

  listMonitored(): readonly EscrowContractDeployment[] {
    return this.deployments.filter((deployment) => deployment.status !== "retired");
  }
}

export function loadEscrowContractRegistry(
  env: NodeJS.ProcessEnv = process.env,
): EscrowContractRegistry {
  const rawRegistry = env.ESCROW_CONTRACTS_JSON?.trim();
  if (rawRegistry) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawRegistry);
    } catch (error) {
      throw new EscrowRegistryConfigError(
        `ESCROW_CONTRACTS_JSON must be valid JSON: ${String(error)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new EscrowRegistryConfigError(
        "ESCROW_CONTRACTS_JSON must be an array of escrow deployments",
      );
    }
    return new EscrowContractRegistry(
      parsed.map((deployment, index) => parseDeployment(deployment, index)),
    );
  }

  const network = env.STELLAR_NETWORK === "PUBLIC" ? "mainnet" : "testnet";
  return new EscrowContractRegistry([
    {
      asset: DEFAULT_SETTLEMENT_ASSET,
      contractId: env.ESCROW_CONTRACT_ID ?? CONTRACTS[network].escrow,
      version: "legacy",
      status: "active",
    },
  ]);
}
