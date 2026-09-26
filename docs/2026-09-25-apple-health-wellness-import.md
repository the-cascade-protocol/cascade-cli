# Apple Health wellness import

`cascade pod import <pod-dir> <Apple Health export folder>` imports the export's
clinical records (the `clinical-records/` FHIR files) and, since 0.23.0, its
wellness data from `export.xml`. This page says what the wellness half reads,
what it writes and where, and which parts are provisional.

Code: `src/lib/apple-health-wellness/`. Rules table:
`src/data/apple-health-wellness-rules.json`. Governing decision:
D-WELLNESS-1 (`spec/decisions/2026-09-19-wellness-reading-identity.md`), with
its amendment that a computed aggregate is a derived view.

## What is read

`export.xml` is read once, as a stream. Samples are spilled to an encrypted
scratch directory, partitioned by UTC day, and each day is processed on its
own, so the samples never sit in memory together. The scratch key exists only
in the importing process and the directory is deleted when the import ends.
What memory does hold is the day's records until the end (tens of thousands of
small objects on a real export) and, while each wellness file is written, that
file's triples (about 300,000 for a year of heart rate). Measured on a real
4.6 GB export: about a minute, peak RSS under 0.9 GB, and it completes with the
heap capped at 384 MB.

- Only top-level `<Record>` elements are read. A `<Record>` inside a
  `<Correlation>` is a copy of a top-level one (the export's DTD says so) and is
  skipped and counted.
- The memory address Apple prints inside the `device` attribute
  (`<<HKDevice: 0x...>`) changes on every export; it is removed before anything
  is digested or retained.
- `export_cda.xml` is a CDA rendering of the same samples and is not read.
  `workout-routes/` and `electrocardiograms/` are not read.

## What is written

| Record | Class | File | Named by |
|---|---|---|---|
| Daily heart rate (min, average, max), resting HR, walking HR average | `health:DailyVitalReading` | `wellness/heart-rate.ttl` | digest seed |
| Daily HRV (SDNN, average) | `health:DailyVitalReading` | `wellness/hrv.ttl` | digest seed |
| Daily respiratory rate, blood oxygen, body mass (average) | `health:DailyVitalReading` | `wellness/body-measurements.ttl` | digest seed |
| Daily active energy (sum, per device) | `health:DailyVitalReading` | `wellness/activity.ttl` | digest seed |
| Daily steps (sum, per device) | `health:DailyActivitySnapshot` | `wellness/activity.ttl` | digest seed |
| Apple's `<ActivitySummary>` day (active energy, exercise minutes, stand hours) | `health:DailyActivitySnapshot` | `wellness/activity.ttl` | its date (tier 1) |
| `<Workout>` (no route) | `health:Workout` | `wellness/activity.ttl` | `HKExternalUUID` or sync identifier (tier 1), else a digest of the element |
| The devices those records name | `health:Device` | `wellness/devices.ttl` **(provisional)** | normalized name + hardware model |

A computed aggregate is written for a day only once the day is **closed**: the
export's `<ExportDate>` falls strictly after the day's end. One record per
(source, device, metric, statistic, day); sources are never merged and no
winner is picked, so choosing between the watch's and the phone's step count is
a reader's rule, not an import rule.

A `health:DailyVitalReading` is filed by its `cascade:loincCode`, from the
rules table. `pod import` and `pod reconcile` route every record through one
function (`dataTypeKeyForSubject` in `src/lib/pod-data-types.ts`), so a later
import or reconcile rewrites each record into the file it was written to.

## Days and the day zone

A sample belongs to the day its start instant falls in, cut in the pod's
`cascade:dayZone` (on `profile/extended.ttl`). Every aggregate records the UTC
interval it covers (`health:periodStart`, `health:periodEnd`, half-open) and the
zone it was cut in (`health:timeZone`). When the pod states no zone, the first
import sets it: the most frequent `HKTimeZone` in the export (an alias such as
`US/Pacific` counts as the zone it names, and the canonical name is written),
else the importing machine's zone, else UTC. The import report (`wellness[].dayZone`) says which
rule applied.

## Retained samples (provisional location)

A computed aggregate is a derived view, so the samples it was computed from are
kept in the pod, and written before the aggregate is.

- **Bytes:** one JSON pack per closed day, at `attachments/sha-256/<digest>`,
  named by the SHA-256 of its bytes (pod-structure.md section 4.3). Plain UTF-8
  JSON, so `pod encrypt` seals it like any other file. Each pack is written as
  soon as its day is computed, not held until the end of the import.
- **Groups:** inside a pack, samples are filed by aggregate group (type, source,
  device), each group keyed by its `sampleDigest`, the digest of exactly the
  samples its aggregates were computed from (the same digest that is an input
  to their names). Samples no aggregate used (a unit the rules do not accept, a
  value that is not a number) are kept under `unaggregated`.
- **Descriptors**, in **`wellness/samples/samples.ttl` (provisional)**: a
  `cascade:Attachment` for each pack, which lists its groups with `dct:hasPart`;
  a node per group (`prov:Entity`, `dct:identifier` its sample digest), named
  from that digest alone; and the `prov:Activity` that names the aggregation
  rule and its version.
- **Links:** each computed aggregate carries `prov:wasDerivedFrom` its GROUP and
  `prov:wasGeneratedBy` the rule activity. A reader goes aggregate, group, the
  pack that lists the group, the pack entry with that `sampleDigest`.

Why groups and not the day's pack: a pack changes whenever any series of its
day changes, and an aggregate pointing at it would then keep its name while one
of its triples changed. A group's name and triples depend only on its own
samples, so one name always carries the same triples. When a later export adds
a sample to one series, that day gets a new pack; every other group of the day
is the same node, now listed by both packs.

Each series inside a group holds packed columns: `start` (seconds after the
day's start), `duration` (seconds), `creation` (epoch seconds), `value` (exactly
as the export wrote it), and, where present, `syncIdentifier`, `syncVersion` and
`externalUuid`. Groups, series and samples are sorted, so the same samples
always give the same bytes and the same name.

## Type index and reconciliation

Each wellness file is registered in `settings/privateTypeIndex.ttl` under every
class its records carry (`health:DailyVitalReading`, `health:DailyActivitySnapshot`,
`health:Workout`, `health:Device`), and listed in `index.ttl`. Both files are
read by parsing, never by searching their text.

Wellness buckets are not reconciled records: a clinical import and
`pod reconcile` do not load them, and a write that routes a record into one
adds to what it holds rather than replacing it.

## What the import reports

Besides the counts above, `wellness[]` in the `--report` JSON carries
`duplicateRecords` (records the export lists more than once with identical
content, written once), `collisions` (a name that arrived with content different
from what the pod or the same export already gave it; nothing is edited in
place and two versions are never merged), `unknownUnits`, and
`unreadRecordTypes`, a count per `<Record>` type this release does not read.

The encrypted scratch directory is removed when the import ends, when it is
interrupted (SIGINT, SIGTERM), and, if the process was killed outright, by the
next import.

## Not yet built

Sleep sessions and the nightly sleep rollup (the export has sleep stage
segments but no session element, so a session is itself a derivation that needs
a rule of its own), blood pressure readings, basal energy (no declared code or
property tells it apart from active energy), VO2 max, and every other sample
type. Workout routes are not read.
