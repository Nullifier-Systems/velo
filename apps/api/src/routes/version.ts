import type { FastifyInstance } from "fastify";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function getCommitHash(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function getDeployTimestamp(): string {
  if (process.env.DEPLOY_TIMESTAMP) return process.env.DEPLOY_TIMESTAMP;
  return new Date().toISOString();
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function versionRoutes(app: FastifyInstance) {
  app.get("/version", async () => ({
    commit: getCommitHash(),
    timestamp: getDeployTimestamp(),
    version: getVersion(),
  }));
}
