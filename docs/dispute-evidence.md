# Dispute evidence

Buyer and provider participants may attach private image evidence to a trade only
while its status is `disputed`. Send the image bytes directly to
`POST /api/v1/cash/request/:id/evidence` with these headers:

- `Content-Type`: `image/jpeg`, `image/png`, or `image/webp`
- `x-stellar-address`: the buyer or provider address recorded on the trade
- `x-file-name`: optional original file name

Images are limited to 5 MiB, and their binary signatures must match the declared
type. Participants can list and download evidence through
the corresponding `GET /cash/request/:id/evidence` routes using their Stellar
address header. Operators use the admin equivalents under
`/admin/trades/:id/evidence` with the existing `x-admin-api-key` header. There is
no public evidence endpoint.

The address header follows the participant-identification convention already used
by the dispute and chat APIs. A future signed-address authentication mechanism
should replace it consistently across those APIs.
