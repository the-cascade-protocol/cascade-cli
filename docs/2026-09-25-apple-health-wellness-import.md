# Apple Health wellness import

`cascade pod import <pod-dir> <Apple Health export folder>` imports the export's
clinical records (the `clinical-records/` FHIR files) and, since 0.24.0, its
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
What memory does hold is the records until they are written (tens of
thousands of small objects on a real export; each file's records are released
once that file is written) and, while each wellness file is written, that
file's triples (about 300,000 for a year of heart rate). Measured on a real
4.6 GB export: about 70 seconds; peak RSS about 1.1 GB with the default heap,
where V8 collects lazily, and it completes with the heap capped at 384 MB
(peak RSS about 0.6 GB).

- Only top-level `<Record>` elements are read as records. A `<Record>` inside a
  `<Correlation>` is a copy of a top-level one (the export's DTD says so) and is
  skipped and counted. The blood pressure correlation is the one place its
  records are read, as the two components of one reading; the top-level copies
  of those components are then the ones skipped.
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
| Daily steps, active energy, basal energy (sum, per device, one snapshot per metric) | `health:DailyActivitySnapshot` | `wellness/activity.ttl` | digest seed |
| Sleep session (stage segments grouped by the sleep rule) | `health:SleepSession` | `wellness/sleep.ttl` | digest seed over its segments |
| Blood pressure reading (one per `<Correlation>`, or per uncorrelated pair) | `health:BloodPressureReading` | `wellness/blood-pressure.ttl` | sync identifier or `HKExternalUUID` on the correlation (tier 1), else a digest of the correlation or of the pair |
| VO2 max estimate (one per sample) | `health:VitalSignReading` | `wellness/body-measurements.ttl` | sync identifier or `HKExternalUUID` (tier 1), else a digest of the sample |
| Apple's `<ActivitySummary>` day (active energy, exercise minutes, stand hours) | `health:DailyActivitySnapshot` | `wellness/activity.ttl` | its date (tier 1) |
| `<Workout>` (no route) | `health:Workout` | `wellness/activity.ttl` | `HKExternalUUID` or sync identifier (tier 1), else a digest of the element |
| The devices those records name | `health:Device` | `wellness/devices.ttl` **(provisional)** | normalized name + hardware model |

A computed aggregate is written for a day only once the day is **closed**: the
export's `<ExportDate>` falls strictly after the day's end. One record per
(source, device, metric, statistic, day); sources are never merged and no
winner is picked, so choosing between the watch's and the phone's step count is
a reader's rule, not an import rule.

A `health:DailyVitalReading` is filed by its `cascade:loincCode`, from the
rules table. A reading with no LOINC code (a VO2 max estimate: health v2.12
removed its wrong code and substituted none) is filed by its SNOMED CT
`fhir:code`. Per-device active energy was written before this release as a
`health:DailyVitalReading` coded only LOINC 41981-2; the table lists that code
as retired, so such a reading stays filed in `wellness/activity.ttl`. `pod import` and `pod reconcile` route every record through one
function (`dataTypeKeyForSubject` in `src/lib/pod-data-types.ts`), so a later
import or reconcile rewrites each record into the file it was written to.

## Sleep sessions

Apple records no sleep session, only stage segments
(`HKCategoryTypeIdentifierSleepAnalysis`), so a session is a derivation with a
rule of its own (the `sleep` block of the rules table, stamped as
`cascade:version "apple-health-sleep-session/1"` on the activity every session
names with `prov:wasGeneratedBy`):

1. Per source (its name and device), segments sorted by start are one group
   until the next one starts an hour or more after the latest end so far. 59
   minutes apart is one session; 60 or more is two.
2. Inside a group, a run of consecutive awake segments spanning an hour or
   more counts as such a gap: the segments before it and after it are two
   sessions, and the run belongs to neither.
3. A piece with no asleep segment (only awake, only in bed, or both) is not a
   session: a sleep episode runs from sleep onset to final waking (IEEE
   1752.1). Its segments are still retained.

So a nap is its own session whenever an hour separates it from the night.
Stage minutes are summed into the totals the vocabulary names: Core into
`health:lightSleepMinutes`, Deep, REM, Awake, and Unspecified (and the older
Asleep value) into `health:asleepUnspecifiedMinutes`. In bed goes to
`health:inBedMinutes` and into no stage. `health:isMainSleep` is never
written: Apple supplies no such flag.

A session is dated by the day it ends, the day of waking: `cascade:date` is
local midnight of that day, as a UTC instant, read in the zone the source
recorded on the segments (`HKTimeZone`, written as `health:timeZone`), or in
the pod's day zone when the source recorded none (and then no
`health:timeZone` is written). A group of segments is written only once it is
closed: the export's coverage ends at least one grouping gap after the group
ends, since a segment the export could not yet hold could otherwise still
join it. An open group waits, whole, for a later export.

The segments are retained as the session's sample group, in the pack of the
pod-zone day the session ends in, and the session points at that group with
`prov:wasDerivedFrom`. A pack is written for such a day even when the day is
still open for aggregation; a later export then gives the day a new pack that
lists the same group. Segments that are in no session (an awake run counted
as a gap, a piece with no asleep segment, a value the table does not map) are
retained under the pack's `unaggregated`. Each sleep segment carries its
`timeZone` column, and a segment that began the day before its pack's day has
a negative `start`.

## Blood pressure and VO2 max

A blood pressure reading is normally paired by the source: HealthKit's blood
pressure `<Correlation>` holds one systolic and one diastolic record, and one
reading record is written from them, flat (`health:systolic`,
`health:diastolic`), coded as the panel (SNOMED CT 75367002, LOINC 85354-9), at
the correlation's start. A correlation without exactly one of each, in mmHg, is
not a reading and is counted as `unpaired`.

The export also repeats each component as a top-level record, and a source can
write a systolic and a diastolic record with no correlation at all. Top-level
components are grouped by (source, start, end):

- Where a correlation component from that source sits at that instant, they
  are skipped and counted: `componentCopies` when identical to it (type,
  value, unit, times), `componentRepeats` when they repeat the same reading
  with another creation time or value. The correlation is the reading, so it
  is never counted twice.
- Elsewhere (`uncorrelatedComponents`), exactly one systolic and one diastolic
  is one reading (`pairedFromComponents`), named by a digest of the two
  records and generated by an activity carrying
  `cascade:version "apple-health-bp-pairing/1"`. A lone half, or more than one
  of either, is not paired and is counted by reason (`uncorrelatedDropped`).

Readings are never averaged: a home average is a view over the readings,
stated with its protocol.

A VO2 max estimate is one record per sample, never a daily series: a
`health:VitalSignReading` coded SNOMED CT 251880009, in mL/kg/min, with
`clinical:measurementMethod` mapped from `HKVO2MaxTestType` (1 maxExercise,
2 predictionSubMaxExercise, 3 predictionNonExercise, 4 predictionStepTest). An
unmapped method value writes no method and is counted.

## A new version of the aggregation rule

A computed aggregate is a derived view, stored as a cache stamped with the
version of the rule that produced it (`prov:wasGeneratedBy` an activity whose
`cascade:version` is `apple-health-daily-aggregate/{version}`). When this
import computes an aggregate whose name the pod already holds, and the held
record was generated by a superseded version of that rule (listed in the rules
table's `supersededRuleVersions`), the held record is replaced in place and
counted (`migratedAggregates`, and `recordsMigrated` per file), instead of
being kept as a collision. Names do not change, so nothing is counted twice.

Nothing else is ever replaced: a record a source supplied (an ActivitySummary
day, a workout, a blood pressure reading, anything named tier 1), a record
generated by the current version, and anything not generated by this rule in
this pod keep the collision rule above. Version 2 of the rule writes a
device's own active energy as `health:activeEnergyKcal` on a per-device
snapshot; version 1 wrote it as a `health:DailyVitalReading` coded only LOINC
41981-2, and a pod imported with version 1 is migrated by importing an export
again.

## The pod subject in every name

Every wellness name (both seeds, in `src/lib/identity.ts`) starts with the pod
subject: the pod's identifier, `cascade:podIdentifier` on `<#me>` in the
owner-only `profile/extended.ttl` (core v3.11), exactly as written. `pod init`
mints it. A pod created before it existed gets one at the start of its first
wellness import, written to the profile before any record is named, and it is
only read back after that. So the same export imported into two pods gives two
disjoint sets of names, and importing it into one pod again gives the same
names. The seed is hashed, so no name reveals the identifier, and the identifier
is never written to `card.ttl` or into an export.

A pod rebuilt from the same exports is a new pod with a new identifier, so its
wellness records get new names; a restore from backup keeps the identifier and
every name. A profile holding two identifiers, a malformed one, or Turtle that
does not parse stops the import before anything is named (`pod doctor` reports
which). A `--dry-run` writes nothing: on a pod with no identifier yet it names
from a placeholder and says so in its warnings.

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
`health:Workout`, `health:Device`, `health:SleepSession`,
`health:BloodPressureReading`, `health:VitalSignReading`), and listed in `index.ttl`. Both files are
read by parsing, never by searching their text.

Wellness buckets are not reconciled records: a clinical import and
`pod reconcile` do not load them, and a write that routes a record into one
adds to what it holds rather than replacing it.

## What the import reports

Besides the counts above, `wellness[]` in the `--report` JSON carries
`podIdentifierMinted` (true when this import minted the pod's identifier; the
value itself is never reported), `duplicateRecords` (records the export lists
more than once with identical content, written once), `collisions` (a name that arrived with content different
from what the pod or the same export already gave it; nothing is edited in
place and two versions are never merged), `unknownUnits`, and
`unreadRecordTypes`, a count per `<Record>` type this release does not read.

The encrypted scratch directory is removed when the import ends, when it is
interrupted (SIGINT, SIGTERM), and, if the process was killed outright, by the
next import.

## Not yet built

The nightly sleep rollup (`health:DailySleepSnapshot`), the source's own
`HKAlgorithmVersion` on a sleep session, and every other sample type. Workout
routes are not read.
