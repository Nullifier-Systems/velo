/**
 * Regenerates the committed openapi.json snapshot from src/openapi.ts.
 *
 * Usage: npm run openapi:generate -w apps/api
 *
 * The snapshot exists so tooling (client generators, linters, AI agents)
 * can consume the spec without running the server. A test asserts the
 * snapshot matches the module — rerun this script whenever the spec
 * module changes.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../src/openapi.js";

const outPath = fileURLToPath(new URL("../openapi.json", import.meta.url));
writeFileSync(outPath, JSON.stringify(openApiDocument, null, 2) + "\n");
console.log(`wrote ${outPath}`);
