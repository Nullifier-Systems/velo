# API Guide

The API layer in Velo provides a lightweight service interface for agent-assisted and application-driven flows.

## Runtime

The API is implemented with Fastify and is intended to expose payment-aware routes for cash-related requests.

## Routes

| Method | Path                          | Price (USDC) | Description                     |
|--------|-------------------------------|--------------|---------------------------------|
| GET    | `/health`                     | Free         | Health check                    |
| GET    | `/api/v1/openapi.json`        | Free         | OpenAPI 3.1 specification       |
| GET    | `/api/v1/services`            | Free         | Service catalog                 |
| GET    | `/api/v1/cash/agents`         | 0.001        | Provider discovery              |
| POST   | `/api/v1/cash/request`        | 0.01         | Create a cash request           |
| GET    | `/api/v1/cash/request/:id`    | Free         | Poll request status             |
| POST   | `/api/v1/cash/request/:id/release` | Free    | Release escrow (hand-off)       |
| POST   | `/api/v1/cash/request/:id/refund`  | Free    | Refund escrow (after timeout)   |
| GET    | `/api/v1/reputation/:address` | 0.0005       | On-chain reputation lookup      |
| GET    | `/api/v1/admin/status`        | Admin auth   | System status & store metrics   |

## Rate Limiting

All API endpoints are rate-limited per IP address to prevent abuse. The following limits are enforced:

| Endpoint                             | Limit                 | Reason                           |
|--------------------------------------|-----------------------|----------------------------------|
| `GET /health`                        | 100 req / 1 min       | Infrastructure health check      |
| `GET /api/v1/openapi.json`           | 60 req / 1 min        | Free specification endpoint      |
| `GET /api/v1/services`               | 60 req / 1 min        | Free catalog endpoint            |
| `GET /api/v1/cash/agents`            | 30 req / 1 min        | Paid discovery; limit abuse      |
| `POST /api/v1/cash/request`          | 20 req / 1 min        | Paid escrow lock (costly)        |
| `GET /api/v1/cash/request/:id`       | 60 req / 1 min        | Free polling                     |
| `POST /api/v1/cash/request/:id/release` | 20 req / 1 min     | Free state transition            |
| `POST /api/v1/cash/request/:id/refund`  | 10 req / 1 min     | Free refund (after timeout)      |
| `GET /api/v1/reputation/:address`    | 30 req / 1 min        | Paid reputation lookup           |
| `GET /api/v1/admin/status`           | 20 req / 1 min        | Admin status (requires API key)  |

When a client exceeds the limit, the API responds with `429 Too Many Requests` and a `Retry-After` header indicating the number of seconds to wait before retrying.

## Admin Authentication

Admin-only endpoints (e.g., `GET /api/v1/admin/status`) are protected by a shared API key.

**Setup:**

1. Generate a secure key:
   ```
   openssl rand -hex 32
   ```
2. Set it in your environment or `.env` file:
   ```
   ADMIN_API_KEY=<your-generated-key>
   ```
3. Restart the API server.

**Usage:**

Include the key as a Bearer token in the `Authorization` header:
```
Authorization: Bearer <admin-api-key>
```

If the key is missing or invalid, the API responds with `401 Unauthorized` or `403 Forbidden`.

## Refund Webhook

When a refund is processed via `POST /api/v1/cash/request/:id/refund`, the API can notify a Slack or Discord channel via a webhook URL.

**Setup:**

1. Create an incoming webhook in your Slack workspace or Discord server.
2. Set the URL in your environment or `.env` file:
   ```
   REFUND_WEBHOOK_URL=https://hooks.slack.com/services/.../.../...
   ```
3. Restart the API server.

The webhook payload includes the trade ID, amount in USDC, buyer address, and seller address. The format auto-detects whether the URL points to Discord or Slack. Leave the variable empty (or unset) to disable webhook notifications entirely.

## Payment Gate

The current implementation uses an x402-style challenge mechanism. When a valid payment header is not present, the API returns a challenge payload rather than allowing unrestricted access.

## Configuration

The API reads environment variables from the local environment or `.env` file. The most important values include the port, merchant address, and network configuration.
