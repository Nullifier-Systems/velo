# Velo API Load Testing & Scaling Plan

**Date:** 2026-07-19  
**Status:** Grounded in Local Concurrency Benchmarks  
**Companion Document:** [Vercel API Load Testing Guide](file:///c:/Users/HP/Desktop/grantfox/1/velo/docs/vercel-api-load-testing.md)

---

## 1. Overview & Test Environment

To evaluate the Velo API layer under concurrent load, benchmark tests were conducted using an automated harness ([`tests/load/concurrency-run.js`](file:///c:/Users/HP/Desktop/grantfox/1/velo/tests/load/concurrency-run.js)) running `autocannon` against the local API server (`@velo/api`). Benchmarks targeted four key endpoints across staged concurrency levels (10, 50, 100, 250, and 500 concurrent connections) for 5-second sampling windows per stage.

### Tested Endpoints:
1. **`GET /health`** — Liveness baseline (In-Memory response, no DB/RPC).
2. **`GET /api/v1/status`** — Read-heavy status endpoint (Soroban RPC `getHealth` + `getLatestLedger` + In-Memory activity read).
3. **`GET /api/v1/cash/request/:id`** — Read-heavy state endpoint (In-Memory Map lookup).
4. **`POST /api/v1/cash/agents`** — Write-heavy registration endpoint (In-Memory Map write).

---

## 2. Load Test Results Summary

Below are the actual benchmark results recorded during execution:

### 2.1 Health Baseline (`GET /health`)
| Concurrency | Throughput (req/s) | p50 Latency (ms) | p99 Latency (ms) | Errors / 429s | Total Requests |
|-------------|--------------------|------------------|------------------|---------------|----------------|
| 10 | 5,739.6 | 1 ms | 8 ms | 0 | 28,708 |
| 50 | 6,347.6 | 7 ms | 25 ms | 0 | 31,781 |
| 100 | 5,746.8 | 15 ms | 49 ms | 0 | 28,830 |
| 250 | 6,039.6 | 39 ms | 78 ms | 0 | 30,443 |
| 500 | 5,869.4 | 78 ms | 480 ms | 0 | 29,845 |

### 2.2 Status Read + Soroban RPC (`GET /api/v1/status`)
| Concurrency | Throughput (req/s) | p50 Latency (ms) | p99 Latency (ms) | Errors / 429s | Total Requests |
|-------------|--------------------|------------------|------------------|---------------|----------------|
| 10 | 4.4 | 1,603 ms | 3,331 ms | 0 | 32 |
| 50 | 1,995.6 | 13 ms | 74 ms | 9,952 (429) | 10,028 |
| 100 | 2,467.0 | 33 ms | 148 ms | 12,333 (429) | 12,433 |
| 250 | 2,596.4 | 69 ms | 449 ms | 12,980 (429) | 13,230 |
| 500 | 4,790.6 | 93 ms | 448 ms | 23,954 (429) | 24,454 |

*Note: Rate limiting (`@fastify/rate-limit` capped at 60 req/min) triggered HTTP 429 responses starting at 50 concurrency.*

### 2.3 Cash Request Read (`GET /api/v1/cash/request/:id`)
| Concurrency | Throughput (req/s) | p50 Latency (ms) | p99 Latency (ms) | Errors / 429s | Total Requests |
|-------------|--------------------|------------------|------------------|---------------|----------------|
| 10 | 4,024.8 | 2 ms | 8 ms | 20,119 (429) | 20,129 |
| 50 | 4,902.0 | 10 ms | 19 ms | 24,507 (429) | 24,557 |
| 100 | 5,433.2 | 16 ms | 42 ms | 27,161 (429) | 27,261 |
| 250 | 4,759.6 | 43 ms | 271 ms | 23,794 (429) | 24,044 |
| 500 | 4,576.6 | 102 ms | 494 ms | 22,881 (429) | 23,381 |

### 2.4 Provider Write (`POST /api/v1/cash/agents`)
| Concurrency | Throughput (req/s) | p50 Latency (ms) | p99 Latency (ms) | Errors / 429s | Total Requests |
|-------------|--------------------|------------------|------------------|---------------|----------------|
| 10 | 3,526.2 | 0 ms | 2 ms | 17,629 (429) | 17,639 |
| 50 | 0.0 (Stalled) | - | - | 100 (Timeout) | 50 |
| 100 | 0.0 (Stalled) | - | - | 200 (Timeout) | 100 |
| 250 | 0.0 (Stalled) | - | - | 500 (Timeout) | 250 |
| 500 | 0.0 (Stalled) | - | - | 1,000 (Timeout) | 500 |

---

## 3. Key Bottlenecks Identified

### Bottleneck 1: Write Endpoint Socket Stalls under Concurrent Load (`POST /api/v1/cash/agents`)
* **Symptom:** At 50+ concurrency, incoming POST requests with JSON payloads stalled completely, causing client-side request timeouts (even with a hard 10s timeout set).
* **Root Cause Analysis:**
  1. **Fastify Rate Limit & Early Response Disconnect:** Under `@fastify/rate-limit` (100 req/min limit), when high-concurrency POST traffic arrives, Fastify's `onRequest` hook intercepts requests and immediately sends an HTTP 429 response, closing the write socket *before* reading the incoming HTTP request body. When hundreds of clients stream POST bodies while the server closes the connection, client TCP sockets enter half-closed / reset states, stalling connection pools.
  2. **Unbuffered Synchronous Console Logging:** Fastify's default `logger: true` emits synchronous console log lines for every request/response. High-concurrency write traffic floods stdout, causing process I/O backpressure.
  3. **Missing Request-Level Timeouts:** Neither Fastify (`app.ts`) nor Node.js has explicit `requestTimeout` or `connectionTimeout` configured, allowing stalled HTTP sockets to remain open indefinitely.

### Bottleneck 2: Synchronous Soroban RPC Blocking in Request Thread (`GET /api/v1/status` & Escrow Routes)
* **Symptom:** At 10 concurrency, `/api/v1/status` throughput dropped to 4.4 req/s with p50 latency jumping to 1,603ms.
* **Root Cause Analysis:**
  1. **Uncached Remote RPC Calls:** [`status.ts`](file:///c:/Users/HP/Desktop/grantfox/1/velo/apps/api/src/routes/status.ts) calls `server.getHealth()` and `server.getLatestLedger()` directly on Stellar's public testnet RPC (`soroban-testnet.stellar.org`) inside the HTTP request thread.
  2. **No Timeout on Soroban SDK Client:** In [`stellar.ts`](file:///c:/Users/HP/Desktop/grantfox/1/velo/apps/api/src/lib/stellar.ts), the `@stellar/stellar-sdk` `Server` instance is instantiated without explicit HTTP request timeouts. Remote RPC delays directly block the single-threaded Node event loop.
  3. **Synchronous Polling for Escrow Operations:** Escrow write routes (`lockEscrow`, `releaseEscrow`, `refundEscrow`) perform a 30-second polling loop (`getTransaction`) inside the HTTP request lifecycle.

### Bottleneck 3: Database Store Concurrency & Pooling (Future-State Vulnerability)
* **Current State:** [`store.ts`](file:///c:/Users/HP/Desktop/grantfox/1/velo/apps/api/src/lib/store.ts) currently uses an in-memory `Map`.
* **Vulnerability:** When migrating to PostgreSQL as outlined in [`docs/db-schema.md`](file:///c:/Users/HP/Desktop/grantfox/1/velo/docs/db-schema.md), unpooled or under-configured database connections will exhaust the PostgreSQL connection limit under 50+ concurrent requests. Without a `connectionTimeoutMillis` cap, requests will queue indefinitely in the Node pool queue.

---

## 4. Grounded Scaling Plan

### 4.1 Request Queuing & Asynchronous Job Architecture
* **Decouple Soroban Transactions from HTTP Handlers:** Move escrow operations (`lockEscrow`, `releaseEscrow`, `refundEscrow`) to an asynchronous job queue (e.g. BullMQ with Redis).
* **Immediate HTTP 202 Response:** HTTP handlers validate requests, write an initial pending status record to the database, enqueue the transaction job, and immediately return `HTTP 202 Accepted` with a `jobId`.
* **Asynchronous Workers & WebSockets:** Background worker processes execute contract calls and transaction status polling. Status updates are pushed to clients via WebSockets (`@fastify/websocket`) or polled via `GET /api/v1/cash/request/:id`.

### 4.2 Soroban RPC Optimization & Caching
* **Short-Lived Ledger Caching:** Cache `getLatestLedger()` and `getHealth()` responses in Redis or in-memory (`toad-cache`) with a 5-second TTL. `/api/v1/status` reads from cache instead of querying Soroban RPC on every request.
* **RPC Request Timeouts:** Configure explicit 5,000ms request timeouts on the `@stellar/stellar-sdk` `Server` client in [`stellar.ts`](file:///c:/Users/HP/Desktop/grantfox/1/velo/apps/api/src/lib/stellar.ts).
* **Dedicated Soroban RPC Node:** For production, replace public testnet RPC endpoints with a dedicated or commercial RPC provider (e.g. QuickNode / Blockdaemon) with guaranteed SLA and rate limits.

### 4.3 Database Connection Pooling (PostgreSQL Migration)
* **Connection Pool Bounds:** Configure the PostgreSQL pool with explicit parameters:
  ```typescript
  const pool = new Pool({
    max: 20, // max active DB connections per API instance
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000, // fail fast after 2s if pool is full
  });
  ```
* **Fast Fail on Pool Exhaustion:** If all DB connections are busy, immediately return `HTTP 503 Service Unavailable` with a `Retry-After` header rather than queuing requests indefinitely.

### 4.4 Fastify Hardening & Rate Limiting Strategy
* **Request & Connection Timeouts:** Configure hard timeouts on the Fastify instance in [`app.ts`](file:///c:/Users/HP/Desktop/grantfox/1/velo/apps/api/src/app.ts):
  ```typescript
  export const app = Fastify({
    logger: { level: "info" },
    connectionTimeout: 15000,
    requestTimeout: 10000,
  });
  ```
* **Asynchronous Logging:** Use pino asynchronous destination (`pino.destination({ sync: false })`) to prevent console I/O blocking under high request throughput.
* **Distributed Redis Rate Limiting:** Move `@fastify/rate-limit` from memory-store to a Redis-backed store to allow rate limits to be shared seamlessly across horizontally scaled API nodes.

### 4.5 Horizontal Scaling Strategy
* **Stateless API Tier:** Deploy API instances as stateless containers (e.g. AWS ECS / Railway / Vercel Serverless Functions) behind an Application Load Balancer (ALB).
* **Auto-Scaling Metrics:** Trigger auto-scaling based on CPU utilization (>70%) and HTTP 429/5xx response rates.
