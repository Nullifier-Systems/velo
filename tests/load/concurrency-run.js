import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PORT = 3001; // Use a different port to avoid conflicts
const BASE_URL = `http://localhost:${PORT}`;
const ENDPOINTS = [
  { name: "Health (Liveness Baseline)", path: "/health", method: "GET" },
  { name: "Status (RPC Read + DB Read)", path: "/api/v1/status", method: "GET" },
  { name: "Cash Request (DB Read Map)", path: "/api/v1/cash/request/aaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111", method: "GET" },
  { name: "Register Provider (DB Write Map)", path: "/api/v1/cash/agents", method: "POST", body: JSON.stringify({ name: "LoadTest Provider", lat: 40.7128, lng: -74.0060 }) }
];

const CONCURRENCY_LEVELS = [10, 50, 100, 250, 500];
const DURATION_SEC = 5;

// Helper to wait
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("=== Velo API Local Concurrency Load Testing ===");
  console.log(`Starting local API server on port ${PORT}...`);

  // Start the server
  const serverEnv = {
    ...process.env,
    PORT: String(PORT),
    STELLAR_NETWORK: "TESTNET",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  };

  const server = spawn("node", ["apps/api/dist/index.js"], {
    env: serverEnv,
    shell: true,
  });

  server.stdout.on("data", (data) => {
    // console.log(`[API Server]: ${data}`);
  });

  server.stderr.on("data", (data) => {
    console.error(`[API Server ERROR]: ${data}`);
  });

  // Ensure server cleanup on exit
  const cleanup = () => {
    console.log("\nStopping API server...");
    server.kill();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Poll /health until server is up
  let retries = 30;
  let serverReady = false;
  while (retries > 0) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        serverReady = true;
        break;
      }
    } catch (err) {
      // Ignore and retry
    }
    await delay(1000);
    retries--;
  }

  if (!serverReady) {
    console.error("Failed to start API server. Exiting.");
    process.exit(1);
  }

  console.log("Local API server is ready. Beginning benchmark runs...");

  const results = [];

  for (const endpoint of ENDPOINTS) {
    console.log(`\n--------------------------------------------------`);
    console.log(`Targeting Endpoint: ${endpoint.method} ${endpoint.path} (${endpoint.name})`);
    console.log(`--------------------------------------------------`);

    for (const concurrency of CONCURRENCY_LEVELS) {
      console.log(`Running with ${concurrency} concurrent connections for ${DURATION_SEC}s...`);

      // Run autocannon
      const metrics = await runAutocannon(endpoint, concurrency);
      results.push({
        endpointName: endpoint.name,
        method: endpoint.method,
        path: endpoint.path,
        concurrency,
        throughput: metrics.requests.average,
        p50: metrics.latency.p50,
        p95: metrics.latency.p95,
        p99: metrics.latency.p99,
        errors: metrics.errors + metrics.timeouts,
        non2xx: metrics.non2xx,
        totalReqs: metrics.requests.sent,
      });

      // Bounded wait between runs to cool down and let rate limiter time window shift
      await delay(2000);
    }
  }

  cleanup();

  // Print results summary
  console.log("\n=== Benchmarks Completed ===");
  generateMarkdownReport(results);
}

function runAutocannon(endpoint, concurrency) {
  return new Promise((resolve, reject) => {
    const args = [
      "autocannon",
      "-c", String(concurrency),
      "-d", String(DURATION_SEC),
      "-m", endpoint.method,
      "-t", "10", // 10s request timeout
      "-j", // output JSON
    ];

    if (endpoint.body) {
      args.push("-b", endpoint.body);
      args.push("-H", "content-type: application/json");
    }

    args.push(`${BASE_URL}${endpoint.path}`);

    const autocannonProcess = spawn("npx", ["--yes", ...args], { shell: true });

    // watchdog timer to prevent Windows process hangs under load
    const watchdog = setTimeout(() => {
      console.log(`Watchdog: Autocannon run for ${endpoint.name} at ${concurrency} concurrency timed out. Force-killing...`);
      autocannonProcess.kill("SIGKILL");
      resolve({
        requests: { average: 0, sent: concurrency },
        latency: { p50: 0, p95: 0, p99: 0 },
        errors: concurrency,
        timeouts: concurrency,
        non2xx: 0
      });
    }, (DURATION_SEC + 15) * 1000); // 20 seconds total watchdog limit

    let stdoutData = "";
    let stderrData = "";

    autocannonProcess.stdout.on("data", (data) => {
      stdoutData += data.toString();
    });

    autocannonProcess.stderr.on("data", (data) => {
      stderrData += data.toString();
    });

    autocannonProcess.on("close", (code) => {
      clearTimeout(watchdog);
      if (code !== 0) {
        if (autocannonProcess.killed) return;
        reject(new Error(`Autocannon failed with code ${code}: ${stderrData}`));
        return;
      }
      try {
        const json = JSON.parse(stdoutData);
        resolve(json);
      } catch (err) {
        resolve({
          requests: { average: 0, sent: concurrency },
          latency: { p50: 0, p95: 0, p99: 0 },
          errors: concurrency,
          timeouts: concurrency,
          non2xx: 0
        });
      }
    });
  });
}

function generateMarkdownReport(results) {
  let md = "# Load Test Concurrency Benchmarks\n\n";
  md += `**Date:** ${new Date().toISOString().split("T")[0]}  \n`;
  md += `**Target Host:** Localhost (In-Memory DB, Testnet Soroban RPC)  \n\n`;

  // Group by endpoint
  const grouped = {};
  for (const r of results) {
    if (!grouped[r.endpointName]) {
      grouped[r.endpointName] = [];
    }
    grouped[r.endpointName].push(r);
  }

  for (const [name, list] of Object.entries(grouped)) {
    const first = list[0];
    md += `## ${name} (${first.method} ${first.path})\n\n`;
    md += `| Concurrency | Throughput (req/s) | p50 Latency (ms) | p95 Latency (ms) | p99 Latency (ms) | Errors (4xx/5xx/Net) | Total Requests |\n`;
    md += `|-------------|--------------------|------------------|------------------|------------------|----------------------|----------------|\n`;
    for (const r of list) {
      md += `| ${r.concurrency} | ${r.throughput.toFixed(1)} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.errors + r.non2xx} | ${r.totalReqs} |\n`;
    }
    md += "\n";
  }

  console.log(md);
  
  // Write report to tests/load/concurrency-results.md
  writeFileSync(join(process.cwd(), "tests/load/concurrency-results.md"), md);
  console.log("Saved report to tests/load/concurrency-results.md");
}

main().catch(console.error);
