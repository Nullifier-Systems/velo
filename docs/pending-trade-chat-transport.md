# Pending Trade Chat: WebSockets vs. Server-Sent Events

**Status:** Recommended  
**Last reviewed:** 2026-07-18

## Context

While a trade is pending, the buyer and provider need low-latency, two-way chat. Velo's API is deployed as a Vercel Function, so the transport must work without relying on a permanently running application server or process-local state.

This decision is time-sensitive. Vercel announced native WebSocket support for Vercel Functions in **Public Beta on 2026-06-22**. Older guidance that Vercel Functions cannot act as WebSocket servers is therefore no longer current, but the beta status still matters for production risk.

Regardless of transport, messages, authorization, membership, and delivery position must live in a shared durable store. Function instances can scale out or be replaced, so neither option may use an in-memory room or message list as its source of truth.

## Comparison

| Concern | WebSockets | Server-Sent Events (SSE) |
| --- | --- | --- |
| Communication model | One persistent, full-duplex connection carries messages in both directions. This maps directly to chat, presence, typing indicators, and read receipts. | One persistent HTTP response carries server-to-client events only. Sending a message still requires a separate `POST` request. |
| Vercel compatibility | Supported by Vercel Functions on Fluid compute, but currently **Public Beta**. Standard Node.js WebSocket libraries and Socket.IO are supported. This repository's Fastify serverless entry point will need a dedicated upgrade route and deployment verification. | Uses ordinary streaming HTTP and is supported by Vercel Functions today. It does not require a protocol upgrade and generally passes through HTTP-oriented infrastructure more predictably. |
| Connection lifetime | Subject to Vercel Function limits and the beta service's behavior. Clients must reconnect after disconnects, deployments, or platform termination. | A stream is an in-flight Function response and is subject to maximum invocation duration. With Fluid compute the documented maximum is 300 seconds on Hobby and 800 seconds on Pro/Enterprise by default, so clients must reconnect periodically. Edge streams can continue for at most 300 seconds. |
| Connection cost | Vercel states that idle WebSocket connection time is not billed; Active CPU billing applies while the Function processes messages. One connection also avoids an HTTP invocation for every client-to-server message. | Each open stream is an invocation. Active CPU pauses while waiting, but provisioned memory remains billed for the lifetime of the in-flight response. Every outbound chat message also creates a separate HTTP invocation. |
| Scale and fan-out | Multiple Function instances require an external pub/sub or realtime broker to route a message to sockets connected to other instances. | The same external pub/sub requirement applies: a POST handler may run in a different instance from either participant's open stream. |
| Browser behavior | Requires explicit reconnect, backoff, heartbeat, authentication refresh, and message-resume logic. It has no built-in last-event cursor. Some restrictive proxies may interfere with upgrades. | `EventSource` reconnects automatically and sends `Last-Event-ID`, making ordered replay simpler. Native `EventSource` cannot set arbitrary authorization headers, so browser authentication normally uses a secure cookie or a short-lived URL token. |
| Implementation complexity | A single bidirectional protocol is conceptually clean, but lifecycle, heartbeat, backpressure, acknowledgements, replay, and beta-platform validation add work. | The receive path is simple text/event-stream HTTP, but the application must coordinate two endpoints (`GET` stream plus `POST` send), CORS/CSRF rules, deduplication, and reconnect replay. |
| Operational maturity | Higher platform risk while Vercel support remains beta; beta behavior or limits may change. | Lower platform risk because it is based on established HTTP streaming, though forced reconnects are normal rather than exceptional. |

## Cost interpretation

Neither transport should be described as free while idle. On Fluid compute, Active CPU is billed only while code executes, but Vercel normally bills provisioned memory while an invocation remains in flight. Vercel's WebSocket beta announcement specifically says idle WebSocket connection time is not billed, which gives WebSockets an advantage for chat sessions that spend most of their time waiting.

SSE can still be economical at small scale, especially when connections are short. At scale, however, every connected participant holds an HTTP response open and every sent message invokes a second endpoint. The dominant costs for both designs will also include the durable message store and the cross-instance pub/sub service.

## Recommendation

Use **WebSockets for the primary pending-trade chat transport**, provided the team accepts Vercel's Public Beta risk and validates the exact Fastify/serverless deployment in a preview environment before release.

The deciding factors are:

1. Chat is naturally bidirectional; WebSockets avoid splitting one conversation across an SSE stream and a POST API.
2. Vercel now supports WebSocket servers directly, removing the former serverless incompatibility.
3. Vercel explicitly excludes idle WebSocket connection time from billing, while an SSE stream remains an in-flight response with provisioned-memory usage.
4. The same durable storage and cross-instance fan-out are required either way, so SSE does not remove the main distributed-systems work.

Treat the connection as a notification channel, not as the data store. Persist each message before broadcasting it, assign a monotonically ordered message ID, authorize both participants against the pending trade, and let reconnecting clients request messages after their last acknowledged ID. Add exponential reconnect backoff and heartbeat handling.

Before production rollout, confirm WebSocket behavior, limits, and observability under the project's Vercel plan. If beta support proves unreliable or the team requires a generally available platform feature, use **SSE plus `POST /trades/:id/messages` as the fallback**. Keeping send and replay operations as normal HTTP APIs makes that fallback possible without changing the persisted chat model.

## Sources

- [Vercel: WebSocket support is now in Public Beta](https://vercel.com/changelog/websocket-support-is-now-in-public-beta)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [Vercel Functions pricing on Fluid compute](https://vercel.com/docs/functions/usage-and-pricing)
- [MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)

