/**
 * Script to verify the health of the API after deployment.
 * It checks the `/health` and `/api/v1/services` endpoints on the live URL.
 *
 * Usage:
 *   npm run post-deploy-check <LIVE_URL>
 *   DEPLOYED_URL=<LIVE_URL> npm run post-deploy-check
 */

import { URL } from "node:url";

async function main() {
  const urlArg = process.argv[2];
  const envUrl = process.env.DEPLOYED_URL || process.env.LIVE_URL || process.env.VERCEL_URL;
  const rawUrl = urlArg || envUrl;

  if (!rawUrl) {
    console.error("Error: Live URL must be provided either as a command line argument or via the DEPLOYED_URL/LIVE_URL/VERCEL_URL environment variable.");
    console.error("Usage examples:");
    console.error("  npm run post-deploy-check -- https://api.velo.example.com");
    console.error("  DEPLOYED_URL=https://api.velo.example.com npm run post-deploy-check");
    process.exit(1);
  }

  let baseUrl: string;
  try {
    const parsedUrl = new URL(rawUrl);
    // Standardize URL by stripping trailing slash
    baseUrl = parsedUrl.origin + parsedUrl.pathname.replace(/\/$/, "");
  } catch (err) {
    console.error(`Error: Invalid URL format: "${rawUrl}"`);
    process.exit(1);
  }

  console.log(`Starting post-deployment checks for base URL: ${baseUrl}`);

  let failed = false;

  // 1. Check /health
  const healthUrl = `${baseUrl}/health`;
  console.log(`Checking health endpoint: GET ${healthUrl}`);
  try {
    const response = await fetch(healthUrl);
    if (!response.ok) {
      console.error(`FAIL: Health check returned HTTP status ${response.status}`);
      failed = true;
    } else {
      const data = await response.json() as any;
      if (data && data.ok === true) {
        console.log("SUCCESS: Health check returned { ok: true }");
      } else {
        console.error("FAIL: Health check response body does not match expected format.", data);
        failed = true;
      }
    }
  } catch (err: any) {
    console.error(`FAIL: Health check request failed: ${err.message}`);
    failed = true;
  }

  // 2. Check /api/v1/services
  const servicesUrl = `${baseUrl}/api/v1/services`;
  console.log(`Checking services endpoint: GET ${servicesUrl}`);
  try {
    const response = await fetch(servicesUrl);
    if (!response.ok) {
      console.error(`FAIL: Services check returned HTTP status ${response.status}`);
      failed = true;
    } else {
      const data = await response.json() as any;
      if (data && Array.isArray(data.services)) {
        console.log(`SUCCESS: Services endpoint returned ${data.services.length} services`);
      } else {
        console.error("FAIL: Services check response body does not contain a 'services' array.", data);
        failed = true;
      }
    }
  } catch (err: any) {
    console.error(`FAIL: Services check request failed: ${err.message}`);
    failed = true;
  }

  if (failed) {
    console.error("FAIL: One or more post-deployment checks failed!");
    process.exit(1);
  }

  console.log("SUCCESS: All post-deployment checks passed successfully!");
}

main().catch((err) => {
  console.error("Unhandled error during post-deployment checks:", err);
  process.exit(1);
});
