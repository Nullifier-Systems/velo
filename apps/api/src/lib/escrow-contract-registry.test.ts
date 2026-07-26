import { describe, expect, it } from "vitest";
import {
  EscrowContractRegistry,
  EscrowRegistryConfigError,
  loadEscrowContractRegistry,
  UnsupportedSettlementAssetError,
} from "./escrow-contract-registry.js";

const USDC_V1 = `C${"A".repeat(55)}`;
const USDC_V2 = `C${"B".repeat(55)}`;
const XLM_V1 = `C${"D".repeat(55)}`;

describe("EscrowContractRegistry", () => {
  it("resolves the single active deployment for each normalized asset", () => {
    const registry = new EscrowContractRegistry([
      {
        asset: "usdc",
        contractId: USDC_V1,
        version: "1.0.0",
        status: "active",
      },
      {
        asset: "XLM",
        contractId: XLM_V1,
        version: "1.0.0",
        status: "active",
      },
    ]);

    expect(registry.resolve(" USDC ")).toMatchObject({
      asset: "USDC",
      contractId: USDC_V1,
    });
    expect(registry.resolve("xlm").contractId).toBe(XLM_V1);
  });

  it("keeps draining deployments discoverable but never routes new trades to them", () => {
    const registry = new EscrowContractRegistry([
      {
        asset: "USDC",
        contractId: USDC_V1,
        version: "1.0.0",
        status: "draining",
      },
      {
        asset: "USDC",
        contractId: USDC_V2,
        version: "2.0.0",
        status: "active",
      },
    ]);

    expect(registry.resolve("USDC").contractId).toBe(USDC_V2);
    expect(registry.listMonitored()).toHaveLength(2);
  });

  it("rejects ambiguous active routes", () => {
    expect(
      () =>
        new EscrowContractRegistry([
          {
            asset: "USDC",
            contractId: USDC_V1,
            version: "1.0.0",
            status: "active",
          },
          {
            asset: "USDC",
            contractId: USDC_V2,
            version: "2.0.0",
            status: "active",
          },
        ]),
    ).toThrow(EscrowRegistryConfigError);
  });

  it("reports unsupported assets without silently falling back", () => {
    const registry = new EscrowContractRegistry([
      {
        asset: "USDC",
        contractId: USDC_V1,
        version: "1.0.0",
        status: "active",
      },
    ]);

    expect(() => registry.resolve("EURC")).toThrow(
      UnsupportedSettlementAssetError,
    );
  });

  it("loads an environment registry and preserves the legacy fallback", () => {
    const configured = loadEscrowContractRegistry({
      ESCROW_CONTRACTS_JSON: JSON.stringify([
        {
          asset: "XLM",
          contractId: XLM_V1,
          version: "3.0.0",
          status: "active",
        },
      ]),
    });
    expect(configured.resolve("XLM").version).toBe("3.0.0");

    const legacy = loadEscrowContractRegistry({
      ESCROW_CONTRACT_ID: USDC_V1,
      STELLAR_NETWORK: "TESTNET",
    });
    expect(legacy.resolve("USDC")).toMatchObject({
      contractId: USDC_V1,
      version: "legacy",
    });
  });
});
