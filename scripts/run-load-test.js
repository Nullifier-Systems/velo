import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIERS = [
  { vus: 1, durationMs: 4000, name: '1 VU Baseline Load' },
  { vus: 10, durationMs: 6000, name: '10 VUs Ramp-Up (Low)' },
  { vus: 50, durationMs: 8000, name: '50 VUs Ramp-Up (Medium)' },
  { vus: 50, durationMs: 15000, name: '50 VUs Sustained Load (Soak Test)' },
  { vus: 100, durationMs: 10000, name: '100 VUs High Concurrency' },
  { vus: 250, durationMs: 10000, name: '250 VUs Peak Spike Test' },
];

const ENDPOINTS = [
  { path: '/health', method: 'GET', weight: 3 },
  { path: '/api/v1/services', method: 'GET', weight: 2 },
  { path: '/api/v1/status', method: 'GET', weight: 2 },
  { path: '/api/v1/cash/agents?lat=19.4326&lng=-99.1332', method: 'GET', weight: 2 },
  { path: '/api/v1/reputation/GACW7A3VJ436Z4IFXRB45Z3P5VTLJSA4LDTR46YQ4P5VL4NFXZ4V63GA', method: 'GET', weight: 1 },
];

function pickEndpoint() {
  const totalWeight = ENDPOINTS.reduce((acc, e) => acc + e.weight, 0);
  let random = Math.random() * totalWeight;
  for (const ep of ENDPOINTS) {
    if (random < ep.weight) return ep;
    random -= ep.weight;
  }
  return ENDPOINTS[0];
}

function makeRequest(url, method) {
  return new Promise((resolve) => {
    const start = performance.now();
    const parsedUrl = new URL(url);

    const req = http.request(
      parsedUrl,
      {
        method,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'VeloLoadTester/1.0',
        },
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          const duration = performance.now() - start;
          resolve({
            statusCode: res.statusCode,
            durationMs: Math.round(duration),
            error: null,
          });
        });
      }
    );

    req.on('error', (err) => {
      const duration = performance.now() - start;
      resolve({
        statusCode: 0,
        durationMs: Math.round(duration),
        error: err.message,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const duration = performance.now() - start;
      resolve({
        statusCode: 504,
        durationMs: Math.round(duration),
        error: 'Request Timeout',
      });
    });

    req.end();
  });
}

function calculatePercentiles(latencies) {
  if (latencies.length === 0) return { p50: 0, p90: 0, p95: 0, p99: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const getP = (p) => sorted[Math.floor(sorted.length * p)] || sorted[sorted.length - 1];
  return {
    p50: getP(0.50),
    p90: getP(0.90),
    p95: getP(0.95),
    p99: getP(0.99),
  };
}

async function runWorker(durationMs, results) {
  const endTime = Date.now() + durationMs;
  while (Date.now() < endTime) {
    const endpoint = pickEndpoint();
    const res = await makeRequest(`${BASE_URL}${endpoint.path}`, endpoint.method);
    results.push(res);
  }
}

async function runTier(tier) {
  console.log(`\n--------------------------------------------------`);
  console.log(`Running Tier: ${tier.name} (${tier.vus} Virtual Users, ${tier.durationMs / 1000}s)`);
  console.log(`--------------------------------------------------`);

  const results = [];
  const startMs = Date.now();
  const workers = Array.from({ length: tier.vus }, () => runWorker(tier.durationMs, results));

  await Promise.all(workers);
  const elapsedSec = (Date.now() - startMs) / 1000;

  const latencies = results.map((r) => r.durationMs);
  const percentiles = calculatePercentiles(latencies);
  const totalRequests = results.length;
  const rps = parseFloat((totalRequests / elapsedSec).toFixed(2));

  const statusCodes = {};
  let totalErrors = 0;
  for (const r of results) {
    statusCodes[r.statusCode] = (statusCodes[r.statusCode] || 0) + 1;
    if (r.statusCode === 0 || r.statusCode >= 500) {
      totalErrors++;
    }
  }

  const errorRatePct = parseFloat(((totalErrors / totalRequests) * 100).toFixed(2));

  console.log(`  Total Requests  : ${totalRequests}`);
  console.log(`  RPS (Req/sec)   : ${rps}`);
  console.log(`  Error Rate      : ${errorRatePct}% (${totalErrors} errors)`);
  console.log(`  Latency p50     : ${percentiles.p50} ms`);
  console.log(`  Latency p90     : ${percentiles.p90} ms`);
  console.log(`  Latency p95     : ${percentiles.p95} ms`);
  console.log(`  Latency p99     : ${percentiles.p99} ms`);
  console.log(`  Status Codes    : ${JSON.stringify(statusCodes)}`);

  return {
    tier: tier.name,
    vus: tier.vus,
    durationSec: elapsedSec,
    totalRequests,
    rps,
    errorRatePct,
    latenciesMs: percentiles,
    statusCodes,
  };
}

async function main() {
  console.log(`==================================================`);
  console.log(`Velo API Load Testing Benchmark Suite`);
  console.log(`Target Base URL: ${BASE_URL}`);
  console.log(`==================================================`);

  const benchmarkReport = {
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
    results: [],
  };

  for (const tier of TIERS) {
    const tierResult = await runTier(tier);
    benchmarkReport.results.push(tierResult);
  }

  const outputPath = path.resolve(__dirname, '../tests/load/load-test-results.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(benchmarkReport, null, 2), 'utf-8');

  console.log(`\n==================================================`);
  console.log(`Benchmark Run Complete!`);
  console.log(`Results saved to: ${outputPath}`);
  console.log(`==================================================`);
}

main().catch((err) => {
  console.error('Fatal load test error:', err);
  process.exit(1);
});
