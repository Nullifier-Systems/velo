# Privacy-Preserving Proximity Matching

Issue #216. Provider discovery previously returned exact coordinates (and an
exact `distance_km`) to any paying requester, broadcasting the real-time
location of someone who may be handling physical cash. This document describes
the mechanism that replaces it and, importantly, reasons about what an adversary
can actually infer.

## Technique: geohash-cell generalization with reveal-on-match

Chosen over cryptographic range proofs because the requirement is a *coarse
region until a match*, not a zero-knowledge predicate. Range proofs would add a
proving system, latency, and a much larger correctness/verification burden for
no additional benefit at this granularity. The mechanism has three parts.

### 1. Cell generalization (the only location ever disclosed)

A provider's exact `(lat, lng)` is treated as secret. Discovery derives its
output **only** from the provider's **geohash cell**
(`apps/api/src/utils/geohash.ts`), default precision 6 (≈ 1.2 km cells):

- The disclosed location is the **cell centroid** (a fixed point per cell), plus
  the geohash string and the cell radius. The real coordinate is never returned.
- This is a full, standard geohash (base-32, bit-interleaved), decoded to exact
  cell bounds — **not** a naive `lat.toFixed(2)` truncation, which leaks a
  non-uniform, axis-aligned box whose real precision is easy to under-estimate.

### 2. Centroid-to-centroid, quantized distance

When the requester supplies a location, the reported distance is computed
between the **query cell centroid** and the **provider cell centroid**, then
quantized into a coarse **band** (`<1km`, `1-2km`, `2-5km`, `5-10km`,
`10-25km`, `>25km`). Both endpoints are snapped to cells and the output is a
band, so the response is a pure function of `(query cell, provider cell)`.

### 3. Reveal-on-match

Exact coordinates are released **only** through
`GET /cash/request/:id/provider-location`, and only once the buyer and the
provider share a **locked escrow** (a confirmed, on-chain, economically-committed
match). A requester with no such trade can never obtain precise coordinates.

## Adversary analysis

**Threat model.** A requester (or many colluding requesters) issues arbitrary
discovery queries, choosing any coordinates and radius, and tries to recover a
target provider's precise location. They can pay the per-query fee repeatedly.

**What they can learn.** The provider's **cell** (~1.2 km at precision 6). That
is the intended, disclosed granularity.

**What they cannot do, and why:**

- **Binary-search / trilateration below a cell.** Because both the provider and
  the query are snapped to cell centroids and the distance is returned as a band,
  moving the query point produces a *step function* that only changes at cell
  boundaries. Within one query cell, every provider in a given cell returns an
  identical band. There is no continuous signal to gradient-descend, so repeated
  queries cannot localize the provider more precisely than one cell. (Tested in
  `privacy.test.ts` → "sweeping the query point yields a step function".)
- **Distinguish two providers in the same cell.** Their entire public view
  (geohash, centroid, band from any query) is byte-for-byte identical. (Tested.)
- **Recover coordinates from inclusion/exclusion at the search boundary.**
  Radius filtering is done at cell granularity with a one-cell tolerance, so the
  in/out decision is a function of the cell, not of exact distance.

**Residual leakage and mitigations:**

- **Cell identity is disclosed.** By design. Choose the precision for the
  deployment's density: precision 5 ≈ 4.9 km for sparse/high-risk areas,
  precision 6 ≈ 1.2 km for dense ones. Configurable per query via `precision`
  (clamped to 4–8).
- **A lone provider in a cell is still "in that cell."** Optional
  **k-anonymity** (`k` query param) suppresses any cell holding fewer than `k`
  available providers, so a single provider is never singled out.
- **The server still stores raw coordinates.** Generalization protects the API
  *responses*. Reducing trust in the server itself (e.g. storing only the cell,
  or a client-side commitment) is a natural follow-up; the response contract
  here does not change if registration later stops persisting raw coordinates.

## API summary

- `GET /api/v1/cash/agents?lat&lng&radius&precision&k` — coarse matches only:
  `{ geohash, approx_lat, approx_lng, cell_radius_m, distance_band }` per agent,
  plus a `privacy` block. Never returns `lat`/`lng`/`distance_km`.
- `GET /api/v1/providers` — coarse directory (same generalization).
- `GET /api/v1/cash/request/:id/provider-location` — exact coordinates, released
  only when the trade is `locked` / `released` / `disputed`.

## Tests

- `apps/api/src/utils/geohash.test.ts` — encoding against reference vectors,
  centroid-in-bounds, same-cell assignment, round-trip.
- `apps/api/src/utils/privacy.test.ts` — no exact coords in the public view,
  same-cell indistinguishability, the step-function property, distance banding,
  cell-granular radius filtering, k-anonymity suppression.
- `apps/api/src/routes/privacy.route.test.ts` — `/cash/agents` never leaks exact
  coordinates; reveal endpoint is gated on a confirmed match.
