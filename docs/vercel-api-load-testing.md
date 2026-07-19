# Cost-Safe Load Testing for the Vercel API

**Status:** Recommended  
**Reviewed:** 2026-07-18

## Recommendation

Use **Artillery** for Velo's API load tests. It fits the existing Node.js repository, keeps the workload in reviewable YAML, supports an exact `arrivalCount`, caps concurrency with `maxVusers`, validates responses with the `expect` plugin, and can fail CI through `ensure` thresholds. Those controls make the request budget visible before a run and reduce the chance that a typo creates an open-ended Vercel bill.

Use k6 if the team later needs richer JavaScript scenarios, tagged sub-metrics, or a dedicated performance-testing platform. It is a strong technical alternative, but adds a separate runtime and its open-model arrival-rate executors can allocate more virtual users up to `maxVUs` to preserve the requested rate. That behavior is useful for controlled performance tests but deserves more care when cost containment is the first requirement.

## Tool comparison

| Tool | Strengths | Cost and cold-start controls | Fit for Velo |
| --- | --- | --- | --- |
| **Artillery** | Native fit for a Node project; readable YAML/TypeScript; HTTP, WebSocket, and Socket.IO support; response assertions and CI thresholds. | `arrivalCount` gives a fixed number of virtual-user arrivals, `maxVusers` caps concurrency, and named phases make warm-up explicit. The request ceiling is easy to calculate as arrivals multiplied by requests per scenario. | **Best fit.** Lowest adoption friction and clearest review-time request budget. |
| **k6** | Excellent JavaScript API, scenarios, tags, thresholds, and Grafana integrations. Constant-arrival executors model a stable request rate accurately. | `iterations` can impose a fixed total. Arrival-rate tests need explicit `preAllocatedVUs` and `maxVUs`; k6 may add VUs up to the cap to maintain rate when the API slows. | Close second. Prefer when analysis sophistication outweighs the extra binary/runtime. |
| **Locust** | Very flexible Python user behavior, distributed workers, and an interactive UI. Good when the team already uses Python. | User loops, spawn rates, run time, and distributed workers combine to determine request volume. A strict global request ceiling needs custom stop logic and is easier to misconfigure. | Too much operational/custom code for this TypeScript monorepo and a simple HTTP API. |
| **Autocannon** | Lightweight Node CLI with high local HTTP throughput and minimal setup. | Connection, pipelining, duration, and amount flags are useful, but it has less built-in scenario modeling, response validation, and cold/warm sample separation. | Useful for local endpoint microbenchmarks, not the default production-facing harness. |

## Vercel-specific testing policy

Vercel Functions are billed from invocations, active CPU, provisioned memory, and data transfer. A load test can therefore create real cost even when responses are errors. Before every non-smoke run:

1. Use a preview or staging project with the same Function settings and data-region placement as production.
2. Set Vercel Spend Management and usage notifications before generating traffic.
3. Write down the maximum request budget. For Artillery, calculate `sum(arrivalCount * requests in the scenario)` and account separately for retries, redirects, setup hooks, and polling.
4. Test only idempotent, unpaid endpoints with synthetic data. Never include `/cash/request`, release, payment verification, or blockchain-writing routes in a generic load suite.
5. Disable redirects so Vercel Authentication or a wrong URL fails visibly instead of adding requests to a login flow.
6. Start with the three-request proof, inspect Vercel logs/usage, then increase one step at a time. Do not jump directly to a stress or soak test.
7. Stop on unexpected status codes, increasing 429/5xx rates, dropped virtual users, or a request count above the written budget.

## Avoiding false cold-start conclusions

Do not remove the first slow sample and call the remainder representative. Cold starts are part of serverless behavior, but mixing a few cold samples into a small steady-state run can distort percentiles.

Report two separate experiments:

- **Cold-candidate latency:** after a documented idle window or a fresh preview deployment, send one request. Label it “cold candidate,” because only Vercel runtime evidence can confirm an actual cold start.
- **Warm/steady latency:** run a small, fixed warm-up budget, discard that run's report, then execute a separately named measurement run at a fixed arrival count/rate. Do not infer a cold start from latency alone; network, region, Vercel Authentication, database connections, and downstream APIs can produce the same symptom.

Capture the deployment ID, Function region, test-generator region, response status, Artillery version, timestamp, exact request count, and matching Vercel runtime logs. Compare like-for-like deployments rather than combining preview and production results.

## Sample and proof run

The committed sample is [`tests/load/vercel-api-smoke.yml`](../tests/load/vercel-api-smoke.yml). It has a hard-coded ceiling of three `GET /health` requests over three seconds, at most three concurrent virtual users, no redirects, a 10-second request timeout, a p95 threshold, and response-status assertions.

Install and run it without adding a repository dependency:

```bash
npx artillery@2.0.33 run tests/load/vercel-api-smoke.yml
```

Set these environment variables before running:

```text
BASE_URL=https://your-authorized-api.example
EXPECTED_STATUS=200
```

For a Vercel-protected staging deployment, obtain an automation bypass secret from the project owner and extend the test defaults with the documented `x-vercel-protection-bypass` header. Do not commit the secret or use an interactive login redirect as the target.

### Observed live-deployment proof

GitHub deployment metadata identified the live Vercel deployment at `velo-4ll67nojr-jotelfootball-techs-projects.vercel.app`. It is protected by Vercel Authentication. On 2026-07-18, Artillery 2.0.33 ran the sample with `EXPECTED_STATUS=302` to verify transport and workload behavior without bypassing that control:

```text
http.requests:              3
http.codes.302:             3
http.request_rate:          1/sec
plugins.expect.ok:          3
vusers.created/completed:   3/3
vusers.failed:              0
http.response_time median:  596 ms
http.response_time p95:     596 ms
```

This proves that Artillery executed the capped scenario against the live deployment and enforced the expected protection response. It does **not** prove `/health` application latency or availability because the request stopped at Vercel Authentication. A true API proof requires an authorized bypass secret or a public staging endpoint and must expect HTTP 200 with `{ "ok": true }`.

## Sources

- [Artillery test script and phase reference](https://www.artillery.io/docs/reference/test-script)
- [Artillery core concepts](https://www.artillery.io/docs/get-started/core-concepts)
- [Grafana k6 scenarios](https://grafana.com/docs/k6/latest/using-k6/scenarios/)
- [Grafana k6 constant arrival rate](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/)
- [Locust documentation](https://docs.locust.io/)
- [Autocannon repository](https://github.com/mcollina/autocannon)
- [Vercel Function pricing](https://vercel.com/docs/functions/usage-and-pricing)
- [Vercel usage and Spend Management](https://vercel.com/docs/pricing/manage-and-optimize-usage)

