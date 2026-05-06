# Cascade Advisory Feed Format (v0.1)

**Status:** v0.1 draft, defined as part of TASK-4.6.
**Profile:** Cascade Advisory Patch v0.1.

## Purpose

A feed is an issuer-published, periodically-refreshed index of CAP advisories. A pod pulls a feed (`cascade advisory feed pull <url>`), inspects entries it has not yet seen, and queues each one for selector evaluation, signature verification, and (per pod policy) auto-apply or user review.

The feed format is deliberately small: it is an **index**, not a transport. The bodies of advisories live at separate URLs; entries reference them by URL. This lets feeds be served from static hosting (CDN, GitHub Pages, IPFS) without re-encoding signatures.

## Document shape

A feed is a single JSON-LD document fetched from a well-known URL (typically `<feed-url>/feed.jsonld`, but `<feed-url>` itself is also acceptable when the URL is known to point at the index).

```json
{
  "@context": {
    "@vocab": "https://ns.cascadeprotocol.org/advisory/v1#",
    "cascade": "https://ns.cascadeprotocol.org/advisory/v1#",
    "id": "@id"
  },
  "feedVersion": "0.1",
  "issuer": "https://clingen.org/affiliation/40016",
  "issuerName": "ClinGen HBOP-VCEP",
  "lastUpdated": "2026-05-04T00:00:00Z",
  "entries": [
    {
      "id": "urn:advisory:clingen-hbop-2026-05-04-001",
      "advisoryClass": "VariantReclassification",
      "cadence": "monthly",
      "applicableUntil": "2031-05-04T00:00:00Z",
      "humanSummary": "BRCA2 c.5946delT reclassified to Likely Pathogenic by HBOP-VCEP. Recommend re-engagement with a genetic counselor.",
      "body": "https://clingen.org/advisories/2026-05-04-001.ldpatch",
      "signature": "https://clingen.org/advisories/2026-05-04-001.jws",
      "issuer": "https://clingen.org/affiliation/40016",
      "issuedAt": "2026-05-04T00:00:00Z"
    }
  ]
}
```

## Entry fields

| Field | Required | Notes |
|-------|----------|-------|
| `id` | Yes | Advisory IRI — must match `advisory:advisoryId` in the body's envelope. |
| `advisoryClass` | Yes | One of the six v0.1 AdvisoryClass individuals (e.g., `VariantReclassification`, `DrugInteraction`, `SafetyCritical`). May be a bare local name (resolved against the advisory namespace) or a full IRI. |
| `cadence` | Yes | Hint for the reminder system (TASK-4.7): `every-app-open`, `daily`, `weekly`, `monthly`, `quarterly`, `annual`. |
| `applicableUntil` | Optional | xsd:dateTime. Past this point, the entry is purged from the active feed. |
| `humanSummary` | Yes | The same one-paragraph text that the body's envelope carries. Surfaced as a preview before the body is downloaded. |
| `body` | Yes | URL of the `.ldpatch` advisory body (UTF-8 text). |
| `signature` | Yes | URL of the detached JWS (`<header>..<signature>` compact form, ASCII text). |
| `issuer` | Yes | Issuer IRI — must match the body's envelope `advisory:issuer` AND the JWS's `iss` header. |
| `issuedAt` | Yes | xsd:dateTime — must match the body's envelope `advisory:issuedAt`. |

## Pull semantics

1. Fetch the feed JSON.
2. For each entry:
   - If `<pod>/.advisory-cache/<advisoryId>.json` exists with `status: applied | declined`, skip.
   - Otherwise, fetch `body` and `signature`.
   - Cache the entry under `<pod>/.advisory-cache/<advisoryId>.json` as `{ status: "pending", entry, fetchedAt }`.
3. Subsequent pulls of the same feed re-skip already-handled entries.

## Cache layout

```
<pod>/
  .advisory-cache/
    urn-advisory-clingen-hbop-2026-05-04-001.json
    urn-advisory-clingen-hbop-2026-05-04-001.body.ldpatch
    urn-advisory-clingen-hbop-2026-05-04-001.body.jws
```

The IRI is filesystem-safe-encoded (slashes/colons → `-`) for the file names. The metadata file is JSON of shape `{ status, entry, fetchedAt, appliedAt?, declinedAt?, declineReason? }`.

## Error handling

Network failures (DNS, TCP, TLS, HTTP non-2xx) do NOT throw. The pull command logs the failure and returns `{ ok: false, reason }` for that feed; the next pull retries. This matches the offline-first design — a pod must work even if the feed is briefly unreachable.

## Future extensions (NOT in v0.1)

- ETag / If-Modified-Since for incremental fetches.
- Multi-issuer aggregator feeds (a feed of feeds).
- Status-list integration (per-advisory revocation without a full feed re-publish).
- Cross-feed signature delegation (`feed-signed-by-distributor-X-on-behalf-of-issuer-Y`).
