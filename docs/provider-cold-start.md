# Provider discovery cold start

Provider discovery returns HTTP `200` with
`availability.state = "no_providers_nearby"` when a valid search has no
approved providers in range. This is an expected supply condition, not an API
failure. Validation, payment, rate-limit, and server failures continue to use
their non-200 status codes and `error` response bodies.

Clients should tell the requester plainly that Velo is not available in the
area yet, keep the provider list empty, and suggest checking back later. They
must not show placeholder providers, imply that location access failed, or
silently expand the requested radius. The response includes a one-hour retry
hint so automated clients do not poll aggressively.

## Operational recommendation

The API emits a structured `provider_discovery_empty` event containing only the
coarse search geohash cell and requested radius. Operations should:

1. Aggregate the event by coarse cell and count unique, privacy-safe demand
   signals over a rolling day.
2. Alert the market-launch team when a cell crosses an agreed demand threshold;
   do not page on a single search.
3. Recruit and approve providers in that market, then verify discovery before
   announcing availability.
4. Offer an explicit opt-in notification when supply launches. Do not retain
   exact requester coordinates or contact details without consent.

The recommended product behavior is to invite the user to check back later (or
opt into a future availability notification), while the operational response is
supply activation rather than treating the empty result as an incident.
