# ADR: Real-Time Pub/Sub Sourcing Strategy for Vercel Serverless Chat

## Status
**Proposed / Accepted**

---

## Context
Deploying a real-time chat feature on a serverless platform like Vercel introduces an architectural challenge: serverless functions are ephemeral, stateless, and short-lived, whereas traditional WebSockets require long-lived, stateful TCP connections. When scaling across multiple serverless function instances, an external Pub/Sub messaging layer is required to broadcast messages across instances.

We researched several pub/sub approaches suited for Vercel:
1. **Redis Pub/Sub (via Upstash)**: Serverless-optimized Redis using HTTP/REST or low-latency connections.
2. **Ably**: Fully managed real-time messaging PaaS with edge support and built-in connection handling.
3. **Pusher Channels**: Hosted managed pub/sub WebSocket routing service.
4. **PostgreSQL / Supabase Realtime**: Database-native LISTEN/NOTIFY primitives.

---

## Decision
We adopt a **Managed Real-Time Provider approach (Ably or Pusher Channels)** or **Serverless Redis (Upstash)** depending on infrastructure constraints, with a primary recommendation toward **Ably** or **Upstash Redis** for handling multi-instance serverless coordination.

### Rationale:
* **Ably / Pusher**: Bypasses Vercel's serverless connection lifespan limits by having clients connect directly to the provider's global edge WebSocket network while Vercel API routes act as lightweight publishers via REST SDKs.
* **Upstash Redis**: Excellent fit for low-cost, serverless-native data passing with zero TCP exhaustion issues over HTTP clients.

---

## Consequences
* **Positive**: Reliable multi-instance scaling on serverless without managing persistent custom WebSocket server daemon infrastructure.
* **Negative / Trade-off**: Third-party SaaS reliance or dependency on caching layers.
