# Graph query surface: JSON output shapes (contract)

**Command:** `cascade pod query` (root backlog 4.6, slice Q1)
**Date:** 2026-07-16
**Audience:** Workbench GraphFactRetriever (G1), the agent's jq usage, the Workbench tauri harness (which mocks these shapes per scenario).

This is a stable, jq-friendly contract. Two read-only views over the pod's stored
forward edges are added; both are additive and deterministic (same pod + same
flags produce byte-identical output). Neither changes any existing output when
its flag is absent.

## Vocabulary conventions used below

- **Record subject:** any named-node subject in the pod that carries an
  `rdf:type`. Record identity is always a full IRI (`urn:uuid:...`), never a CURIE.
- **Edge:** any triple whose subject and object are both record subjects in the
  same pod. No predicate is hardcoded: `rdf:type`, code-system IRIs, and vocab
  terms fall out because their objects are not record subjects, and future
  reason/encounter edges flow through with zero changes. Forward edges are
  stored; both directions are traversed at query time (nothing inverse is
  materialized).
- **IRIs vs labels:** record identity fields (`iri`, `subject`, `object`) are
  full IRIs. Semantic-label fields (`type`, `edge`, `predicate`) are CURIEs
  (`clinical:hasLabResult`), falling back to the full IRI when no known prefix
  matches.

## 1. `pod query --neighbors <iri> [--hops N] [--edge <pred>...]`

Returns the typed neighborhood of one record, traversing stored edges in both
directions up to `N` hops.

- `--hops N` — traversal depth. Default `1`, capped at `3`. A non-positive or
  non-integer value is a clean error (exit 1).
- `--edge <pred>` — repeatable. Restricts traversal to these edge predicates.
  Accepts a full IRI or a `prefix:local` CURIE (resolved against the Cascade
  prefix table plus the well-known prefixes). An unknown prefix is a clean error.
- Unknown / absent seed IRI (not a record subject in this pod): clean error, exit 1.

`--json` output:

```json
{
  "pod": "<pod-dir arg, verbatim>",
  "seed": {
    "iri": "urn:uuid:6284c56d-...",
    "type": "clinical:LaboratoryReport",
    "label": "Basic Metabolic Panel",
    "properties": { "clinical:reportDate": "2019-05-01", "clinical:hasLabResult": "urn:uuid:..." }
  },
  "hops": 2,
  "edgeFilters": ["clinical:hasLabResult"],
  "neighbors": [
    { "iri": "urn:uuid:34e0...", "type": "health:LabResultRecord", "edge": "clinical:hasLabResult", "direction": "out", "hop": 1 },
    { "iri": "urn:uuid:6add...", "type": "health:LabResultRecord", "edge": "clinical:hasLabResult", "direction": "in",  "hop": 2 }
  ]
}
```

Field notes:

- `seed` reuses the flat record summary shape (`iri`, `type`, `label?`,
  `properties`) so a consumer that already handles `query` records can handle it.
  `properties` keys are CURIEs; values are the object (multi-valued joined with
  `", "`).
- `label` is omitted when no name-like property is present.
- `edgeFilters` is always an array (empty when no `--edge` was given), echoing the
  applied filters as CURIEs.
- Each `neighbors` entry:
  - `direction: "out"` — the seed-side record is the edge **subject**
    (`seed --edge--> neighbor`). `"in"` — the seed-side record is the edge
    **object** (`neighbor --edge--> seed`).
  - `hop` — 1-based traversal depth at which this record was first reached.
- **Traversal semantics:** breadth-first; each record is emitted **once**, at the
  hop where first reached, labelled with the edge that reached it. The seed is
  never emitted as its own neighbor. When more than one edge reaches the same new
  record in the same hop, the reported edge is the lowest-sorted candidate
  (predicate IRI, then direction, then neighbor IRI).
- **Ordering** within the array is deterministic: predicate IRI, then direction
  (`in` before `out`), then neighbor IRI, applied per hop.

## 2. `pod query --all --edges`

Adds a top-level `edges` array to the existing `--all` output. **Strictly
additive:** without `--edges` the output is byte-identical to before this slice.
`--edges` requires `--all` (otherwise a clean error).

```json
{
  "pod": "<pod-dir arg>",
  "dataTypes": { "...": "unchanged existing flat per-type buckets ..." },
  "edges": [
    { "subject": "urn:uuid:0e6d...", "predicate": "clinical:hasLabResult", "object": "urn:uuid:a493..." },
    { "subject": "urn:uuid:bca4...", "predicate": "coverage:relatedClaim",  "object": "urn:uuid:6b77..." }
  ]
}
```

- `edges` contains every record-to-record edge in the pod (both `subject` and
  `object` are record subjects), one row per distinct triple.
- **Ordering** is deterministic: predicate IRI, then subject IRI, then object IRI.
- `subject` and `object` are full IRIs; `predicate` is a CURIE.

## Which containers the graph covers

The graph loads exactly the file set `query --all` reads: every `*.ttl` under the
pod **except** `index.ttl`, `manifest.ttl`, `profile/card.ttl`,
`settings/publicTypeIndex.ttl`, and `settings/privateTypeIndex.ttl`. Recursive
discovery means `clinical/`, `wellness/`, and any additional containers a future
slice adds (for example `notes/`, `investigations/`, `annotations/`) are covered
automatically the moment they hold `.ttl` records: their typed subjects become
record subjects and any record-to-record edges to or from them flow through the
generic edge definition with no change here. Encrypted pods decrypt transparently
before parsing, exactly like `query --all`.

Note (per root backlog 3.10): a dedicated `--notes` / assertions **query verb**
is still out of scope for this slice. The point above is only that the graph load
does not *exclude* those containers; it does not add a semantic notes surface.

## Determinism guarantee

For a given pod, `--neighbors <iri> [flags]` and `--all --edges` each produce
byte-identical stdout on repeated invocations. Ordering is fixed by IRI, never by
store-internal or filesystem order. This is what lets the Workbench harness mock a
canned neighborhood per scenario and compare against real CLI output.
