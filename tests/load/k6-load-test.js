import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics tracking per-endpoint latencies and failure rates
const latencyHealth = new Trend('latency_health');
const latencyServices = new Trend('latency_services');
const latencyStatus = new Trend('latency_status');
const latencyAgents = new Trend('latency_agents');
const latencyReputation = new Trend('latency_reputation');
const latencyCashRequest = new Trend('latency_cash_request');

const rateLimitCounter = new Counter('rate_limit_429');
const rpcTimeoutCounter = new Counter('rpc_timeout_504');
const serverErrorCounter = new Counter('server_error_500');
const successRate = new Rate('successful_requests');

export const options = {
  scenarios: {
    // Stage 1: Baseline single-user execution
    baseline: {
      executor: 'constant-vus',
      vus: 1,
      duration: '10s',
    },
    // Stage 2: Low Concurrency (10 VUs)
    low_concurrency: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '5s', target: 10 },
        { duration: '15s', target: 10 },
        { duration: '5s', target: 0 },
      ],
      startTime: '10s',
    },
    // Stage 3: Medium Concurrency (50 VUs)
    medium_concurrency: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '5s', target: 50 },
        { duration: '20s', target: 50 },
        { duration: '5s', target: 0 },
      ],
      startTime: '35s',
    },
    // Stage 4: High Concurrency (100 VUs)
    high_concurrency: {
      executor: 'ramping-vus',
      startVUs: 50,
      stages: [
        { duration: '5s', target: 100 },
        { duration: '20s', target: 100 },
        { duration: '5s', target: 0 },
      ],
      startTime: '65s',
    },
    // Stage 5: Peak Concurrency Stress Test (250 VUs)
    peak_concurrency: {
      executor: 'ramping-vus',
      startVUs: 100,
      stages: [
        { duration: '5s', target: 250 },
        { duration: '20s', target: 250 },
        { duration: '5s', target: 0 },
      ],
      startTime: '95s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.10'], // Less than 10% total failure allowed
    http_req_duration: ['p(95)<2000'], // 95% of requests should complete within 2s
    successful_requests: ['rate>0.90'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  // 1. Health check (unauthenticated infrastructure check)
  group('GET /health', function () {
    const res = http.get(`${BASE_URL}/health`);
    latencyHealth.add(res.timings.duration);
    const pass = check(res, {
      'status is 200': (r) => r.status === 200,
      'has ok true': (r) => r.json() && r.json().ok === true,
    });
    successRate.add(pass);
    trackErrors(res);
  });

  sleep(0.5);

  // 2. Services catalog
  group('GET /api/v1/services', function () {
    const res = http.get(`${BASE_URL}/api/v1/services`);
    latencyServices.add(res.timings.duration);
    const pass = check(res, {
      'status is 200': (r) => r.status === 200,
    });
    successRate.add(pass);
    trackErrors(res);
  });

  sleep(0.5);

  // 3. Status activity feed
  group('GET /api/v1/status', function () {
    const res = http.get(`${BASE_URL}/api/v1/status`);
    latencyStatus.add(res.timings.duration);
    const pass = check(res, {
      'status is 200': (r) => r.status === 200,
    });
    successRate.add(pass);
    trackErrors(res);
  });

  sleep(0.5);

  // 4. Cash Agents (Provider discovery)
  group('GET /api/v1/cash/agents', function () {
    const res = http.get(`${BASE_URL}/api/v1/cash/agents?lat=19.4326&lng=-99.1332`);
    latencyAgents.add(res.timings.duration);
    const pass = check(res, {
      'status is 200 or 402': (r) => r.status === 200 || r.status === 402,
    });
    successRate.add(pass);
    trackErrors(res);
  });

  sleep(0.5);

  // 5. Reputation Lookup
  group('GET /api/v1/reputation/:addr', function () {
    const testAddr = 'GACW7A3VJ436Z4IFXRB45Z3P5VTLJSA4LDTR46YQ4P5VL4NFXZ4V63GA';
    const res = http.get(`${BASE_URL}/api/v1/reputation/${testAddr}`);
    latencyReputation.add(res.timings.duration);
    const pass = check(res, {
      'status is 200 or 402': (r) => r.status === 200 || r.status === 402,
    });
    successRate.add(pass);
    trackErrors(res);
  });

  sleep(1);
}

function trackErrors(res) {
  if (res.status === 429) {
    rateLimitCounter.add(1);
  } else if (res.status === 504) {
    rpcTimeoutCounter.add(1);
  } else if (res.status >= 500) {
    serverErrorCounter.add(1);
  }
}
