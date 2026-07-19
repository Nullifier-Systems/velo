# Load Test Concurrency Benchmarks

**Date:** 2026-07-19  
**Target Host:** Localhost (In-Memory DB, Testnet Soroban RPC)  

## Health (Liveness Baseline) (GET /health)

| Concurrency | Throughput (req/s) | p50 Latency (ms) | p95 Latency (ms) | p99 Latency (ms) | Errors (4xx/5xx/Net) | Total Requests |
|-------------|--------------------|------------------|------------------|------------------|----------------------|----------------|
| 10 | 5739.6 | 1 | undefined | 8 | 0 | 28708 |
| 50 | 6347.6 | 7 | undefined | 25 | 0 | 31781 |
| 100 | 5746.8 | 15 | undefined | 49 | 0 | 28830 |
| 250 | 6039.6 | 39 | undefined | 78 | 0 | 30443 |
| 500 | 5869.4 | 78 | undefined | 480 | 0 | 29845 |

## Status (RPC Read + DB Read) (GET /api/v1/status)

| Concurrency | Throughput (req/s) | p50 Latency (ms) | p95 Latency (ms) | p99 Latency (ms) | Errors (4xx/5xx/Net) | Total Requests |
|-------------|--------------------|------------------|------------------|------------------|----------------------|----------------|
| 10 | 4.4 | 1603 | undefined | 3331 | 0 | 32 |
| 50 | 1995.6 | 13 | undefined | 74 | 9952 | 10028 |
| 100 | 2467.0 | 33 | undefined | 148 | 12333 | 12433 |
| 250 | 2596.4 | 69 | undefined | 449 | 12980 | 13230 |
| 500 | 4790.6 | 93 | undefined | 448 | 23954 | 24454 |

## Cash Request (DB Read Map) (GET /api/v1/cash/request/aaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111)

| Concurrency | Throughput (req/s) | p50 Latency (ms) | p95 Latency (ms) | p99 Latency (ms) | Errors (4xx/5xx/Net) | Total Requests |
|-------------|--------------------|------------------|------------------|------------------|----------------------|----------------|
| 10 | 4024.8 | 2 | undefined | 8 | 20119 | 20129 |
| 50 | 4902.0 | 10 | undefined | 19 | 24507 | 24557 |
| 100 | 5433.2 | 16 | undefined | 42 | 27161 | 27261 |
| 250 | 4759.6 | 43 | undefined | 271 | 23794 | 24044 |
| 500 | 4576.6 | 102 | undefined | 494 | 22881 | 23381 |

## Register Provider (DB Write Map) (POST /api/v1/cash/agents)

| Concurrency | Throughput (req/s) | p50 Latency (ms) | p95 Latency (ms) | p99 Latency (ms) | Errors (4xx/5xx/Net) | Total Requests |
|-------------|--------------------|------------------|------------------|------------------|----------------------|----------------|
| 10 | 3526.2 | 0 | undefined | 2 | 17629 | 17639 |
| 50 | 0.0 | 0 | 0 | 0 | 100 | 50 |
| 100 | 0.0 | 0 | 0 | 0 | 200 | 100 |
| 250 | 0.0 | 0 | 0 | 0 | 500 | 250 |
| 500 | 0.0 | 0 | 0 | 0 | 1000 | 500 |

