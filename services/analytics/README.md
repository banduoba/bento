# Bento usage API

This independent Worker receives optional anonymous Bento launch reports. It does
not receive file names, paths, searches, account information, or device serials.
The application stores a random UUIDv4 locally; disabling usage statistics stops
reports. Only reports received after launch count toward the totals.

`POST /v1/events` with `Content-Type: application/json`:

```json
{"installationId":"e772714f-de4a-49bc-9ba7-05a1005d6f1b","version":"0.3.1","platform":"macos","arch":"arm64","type":"launch"}
```

The five fields above are required and extra fields are rejected. Supported
architectures are `arm64` and `x86_64`. The body must be at most 512 bytes.
Successful requests return `204`; invalid reports return `400`, unsupported media
`415`, oversized bodies `413`, denied origins `403`, throttled requests `429`,
and temporary failures `503`. No client secret is needed. CORS permits only Tauri
origins; native requests without an Origin header are accepted. CORS is not proof
that a request came from Bento.

The server uses UTC dates and atomically deduplicates each installation per day.
Lifetime totals count random installations that have reported at least once,
not downloads or people. Reinstalling or deleting settings can create a new ID;
offline use, disabled reporting, failed requests, and rate limits can undercount.
An unauthenticated ingestion endpoint can receive forged reports. Global and
per-installation rate limits are best effort per Cloudflare location, not a
global cost cap. Request IPs are not read or stored by this service. Persisted
Worker request logging is disabled; Cloudflare still handles transport metadata.

The private dashboard at `/dashboard` accepts an owner token in a password input.
Only authenticated `/v1/stats` requests return aggregate data. The token is held
in page memory and sent in an Authorization header, never a URL or local storage.
Version and architecture breakdowns show each installation's latest report;
7-day and 30-day counts include today and count distinct installations. Daily
membership is retained for 35 UTC dates; lifetime installation records remain.

For local checks, use Node 24+ and run `npm ci`, `npm test`, then `npm run check`
from this directory. Tests execute the production SQL against in-memory SQLite.
