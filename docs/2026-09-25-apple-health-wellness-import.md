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

`export.xml` is read once, as a stream. Memory does not grow with the file:
samples are spilled to an encrypted scratch directory, partitioned by UTC day,
and each day is processed on its own. The scratch key exists only in the
importing process and the directory is deleted when the import ends.

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
import sets it: the most frequent `HKTimeZone` in the export, else the importing
machine's zone, else UTC. The import report (`wellness[].dayZone`) says which
rule applied.

## Retained samples (provisional location)

A computed aggregate is a derived view, so the samples it was computed from are
kept in the pod, and written before the aggregate is.

- **Bytes:** one JSON file per closed day, at `attachments/sha-256/<digest>`,
  named by the SHA-256 of its bytes (pod-structure.md section 4.3). Plain UTF-8
  JSON, so `pod encrypt` seals it like any other file.
- **Descriptors:** a `cascade:Attachment` for each file, plus the `prov:Activity`
  that names the aggregation rule and its version, in
  **`wellness/samples/samples.ttl` (provisional)**.
- **Links:** each computed aggregate carries `prov:wasDerivedFrom` its day's
  file and `prov:wasGeneratedBy` the rule activity.

The file holds, per series (type, source name, source version, unit, device
with its address removed), packed columns: `start` (seconds after the day's
start), `duration` (seconds), `creation` (epoch seconds), `value` (exactly as
the export wrote it), and, where present, `syncIdentifier`, `syncVersion` and
`externalUuid`. Series and samples are sorted, so the same samples always give
the same bytes and the same name.

## Not yet built

Sleep sessions and the nightly sleep rollup (the export has sleep stage
segments but no session element, so a session is itself a derivation that needs
a rule of its own), blood pressure readings, basal energy (no declared code or
property tells it apart from active energy), VO2 max, and every other sample
type. Workout routes are not read.
