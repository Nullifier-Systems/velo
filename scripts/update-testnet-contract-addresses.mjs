import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const contractIdPattern = /^C[A-Z2-7]{55}$/;
const defaultRegistry = "packages/shared/src/index.ts";

function currentAddresses(source) {
  const testnet = source.match(/testnet:\s*{([\s\S]*?)\n\s*},/);
  if (!testnet) throw new Error("Could not find CONTRACTS.testnet in the registry.");

  const escrow = testnet[1].match(/escrow:\s*"([^"]+)"/);
  const atomicSwap = testnet[1].match(/atomicSwapA:\s*"([^"]+)"/);
  if (!escrow || !atomicSwap) throw new Error("Could not find both testnet address fields.");
  return { escrow: escrow[1], atomicSwap: atomicSwap[1] };
}

function validate(addresses) {
  for (const [name, address] of Object.entries(addresses)) {
    if (!contractIdPattern.test(address)) {
      throw new Error(`Invalid ${name} contract address: ${address}`);
    }
  }
}

const checkOnly = process.argv[2] === "--check";
const registry = checkOnly ? defaultRegistry : (process.argv[4] ?? defaultRegistry);
const original = await readFile(registry, "utf8");

if (checkOnly) {
  validate(currentAddresses(original));
  console.log("Testnet contract addresses are valid.");
  process.exit(0);
}

const addresses = { escrow: process.argv[2], atomicSwap: process.argv[3] };
validate(addresses);

const updated = original
  .replace(/(testnet:\s*{[\s\S]*?escrow:\s*)"[^"]+"/, `$1"${addresses.escrow}"`)
  .replace(/(testnet:\s*{[\s\S]*?atomicSwapA:\s*)"[^"]+"/, `$1"${addresses.atomicSwap}"`);

if (updated === original) throw new Error("Registry update did not change either address.");
validate(currentAddresses(updated));

const temporary = join(dirname(registry), `.contract-addresses-${randomUUID()}.tmp`);
await writeFile(temporary, updated, { encoding: "utf8", flag: "wx" });
await rename(temporary, registry);
