# Request Tracing

Every API request is assigned a **request ID** that appears on every log
line emitted while handling that request — including the on-chain escrow
lifecycle (simulate → sign → submit → poll) executed by
`apps/api/src/lib/stellar.ts`. This makes it possible to reconstruct the
full story of a single failed call from production logs.

## How request IDs are assigned

The ID is chosen in `apps/api/src/app.ts` (`genReqId`), in this order:

1. **Inbound `x-request-id` header** — if the client (or an upstream
   proxy) supplies one, it is reused as-is. Retrying clients can send the
   same ID to correlate retries. IDs longer than 128 characters are
   rejected and replaced with a generated one.
2. **Vercel's `x-vercel-id` header** — Vercel's edge attaches this to
   every function invocation (e.g. `iad1::abcd-1234567890`). Reusing it
   means our `reqId` matches the ID Vercel's own log viewer groups
   request logs by.
3. **Generated UUID** — a `crypto.randomUUID()` fallback for direct
   calls (local dev, curl, tests).

The chosen ID is always echoed back to the client in the
**`x-request-id` response header**, on both success and error responses.

## What the logs look like

Fastify binds the ID to the request-scoped logger as `reqId`, so every
line logged via `req.log` carries it automatically:

```json
{"level":30,"reqId":"3f6d2c1e-…","msg":"incoming request","req":{"method":"POST","url":"/api/v1/cash/request"}}
{"level":30,"reqId":"3f6d2c1e-…","contract":"CDLZ…","fn":"lock","stage":"build","signer":"GB3K…","msg":"building contract invocation"}
{"level":30,"reqId":"3f6d2c1e-…","contract":"CDLZ…","fn":"lock","stage":"simulate","msg":"simulating transaction"}
{"level":30,"reqId":"3f6d2c1e-…","contract":"CDLZ…","fn":"lock","stage":"sign","txHash":"9c0a…","msg":"transaction signed"}
{"level":30,"reqId":"3f6d2c1e-…","contract":"CDLZ…","fn":"lock","stage":"submit","txHash":"9c0a…","status":"PENDING","msg":"transaction accepted"}
{"level":30,"reqId":"3f6d2c1e-…","contract":"CDLZ…","fn":"lock","stage":"poll","txHash":"9c0a…","attempts":4,"elapsedMs":5892,"msg":"transaction confirmed"}
{"level":30,"reqId":"3f6d2c1e-…","msg":"request completed","res":{"statusCode":201}}
```

The escrow helpers (`lockEscrow`, `releaseEscrow`, `refundEscrow`)
accept the request-scoped logger and stamp each lifecycle stage with a
`stage` field:

| `stage`    | Meaning                                                        |
|------------|----------------------------------------------------------------|
| `build`    | Fetching the source account and building the transaction        |
| `simulate` | Soroban RPC simulation (failures logged with the RPC error)     |
| `sign`     | Transaction assembled and signed; `txHash` is known from here   |
| `submit`   | Submission to the network (`status` shows the RPC verdict)      |
| `poll`     | Confirmation polling (`attempts`, `elapsedMs`, final `status`)  |

When an invocation fails, an `error`-level line is emitted with the
`stage` that failed **before** the error propagates up to the route
handler, so you can see exactly how far the transaction got.

## Tracing a failed request in Vercel's log viewer

Say a client reports a failed `POST /api/v1/cash/request`:

1. **Get the request ID.** It is in the `x-request-id` header of the
   failed response. If the client did not record it, the `x-vercel-id`
   response header (added by Vercel) works too — when Vercel forwards
   the request, that same value is adopted as the `reqId`.
2. **Open the log viewer.** Vercel dashboard → your project →
   **Logs** (under *Observability*). Pick a time range covering the
   failure.
3. **Search for the ID.** Paste the request ID into the search box. All
   log lines whose JSON contains that `reqId` are shown — the incoming
   request, each escrow `stage`, and the response line.
4. **Find the failing stage.** Look for the `error`-level line and read
   its `stage` field:
   - `stage: "simulate"` → the contract rejected the call (bad args,
     insufficient balance, contract logic). The `error` field carries the
     RPC diagnostic.
   - `stage: "submit"` → the network rejected the envelope (`errorResult`
     has the XDR result code, e.g. `txBadSeq`).
   - `stage: "poll"` → the transaction was accepted but failed or timed
     out on-chain. Take the `txHash` to
     [Stellar Expert](https://stellar.expert/explorer/testnet) or
     `stellar tx fetch` for the on-chain view.

From the CLI, the same works with:

```bash
vercel logs <deployment-url> --json | grep '3f6d2c1e-…'
```

## Local development

Locally the logs go to stdout as pino JSON. Pipe through
[pino-pretty](https://github.com/pinojs/pino-pretty) and grep the same
way:

```bash
npm run dev --workspace @velo/api | npx pino-pretty
# reproduce the failure, note the x-request-id from the response, then:
curl -si localhost:3000/api/v1/cash/request/... | grep -i x-request-id
```

## Propagating the ID from your own client

Send your own `x-request-id` (≤128 chars) and the API will adopt it,
letting you correlate client-side logs with server-side ones:

```bash
curl -H "x-request-id: my-trace-42" https://api.velo.cash/api/v1/services
```
