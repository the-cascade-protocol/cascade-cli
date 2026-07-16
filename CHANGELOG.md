# Changelog

All notable changes to `@the-cascade-protocol/cli` are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed

- **Cross-record reference edges now resolve on import** (root backlog 2.6). The FHIR converters wrote `clinical:hasLabResult` (DiagnosticReport to Observation) and `coverage:relatedClaim` (ExplanationOfBenefit to Claim) as `urn:uuid:<last-path-segment>`, which dangled 100% of the time: referenced records get content-hashed or deterministically minted subjects (never the raw id), and `urn:uuid:` fullUrl references got a second `urn:uuid:` prepended. Both edge families now go through one path. Converters emit each edge as a placeholder carrying the raw reference; at the end of a conversion batch, when every record's minted subject is known, the reference is rewritten to that real subject IRI. An edge is written only when it resolves; a reference whose target is absent from the batch is dropped and counted, and the import summary reports the tally (total plus per-predicate). Reference normalization handles `Observation/<id>`, `urn:uuid:<id>` (no double prefix), absolute URLs, and `/_history/` suffixes. Subject minting is unchanged. Verified: fresh Synthea specimen census shows 31/31 `hasLabResult` and 18/18 `relatedClaim` resolving as real subject IRIs with zero dangling or placeholder IRIs anywhere (was 0/49); two imports of the specimen produce byte-identical clinical containers (timestamps excepted); full suite green.
- **Type index is valid Turtle after a claims import** (root backlog 1.6). When `cascade pod import` appended a `solid:TypeRegistration` block, it self-healed only the `fhir:` prefix, so registering a coverage class (Claim / ExplanationOfBenefit) wrote `coverage:...` into a file with no `@prefix coverage:` declaration. The result was an unparseable `settings/publicTypeIndex.ttl` (`Undefined prefix "coverage:"`) on every fresh pod that touched claims data, which broke any strict-Turtle consumer (validators, other Cascade apps, the coming graph-query surface). The self-heal now declares any Cascade prefix the appended block uses and the file lacks, and `pod init` seeds the index templates with `coverage:` (public) and `fhir:` (private) so new pods start complete. Verified: fresh Synthea import's `publicTypeIndex.ttl` parses under n3 strict mode (it failed on line 46 before).

### Changed

- **Draft shapes synced from spec** (`sync-shapes-from-spec.sh`; batched per `spec/PENDING_DOWNSTREAM_SYNC.md`): `evidence.shapes.ttl` now carries the verdict-taxonomy v2 facet model (spec evidence v1-draft.0.2 — facet-consistency constraints + the generalized SHACL-Core grounding invariant), and `workbench.shapes.ttl` gains the Web Annotation note shapes (spec workbench v1-draft.0.5 — `WebAnnotationShape` / `CommentingBodyShape` / `FollowUpShape`, so `cascade validate` enforces target + motivation + PROV attribution on `oa:Annotation` notes, a body on commenting notes, and the RFC 5545 `ical:status` enum on follow-ups by default). Verified: full suite green (992 passed); positive/negative note fixtures pass/fail as intended against the embedded shapes.

---

## [0.7.0] - 2026-06-26

### Added

- **Folder and vendor-export import (source-adapter layer).** `cascade pod import` now accepts a directory, not just files. A new source-adapter registry detects the container shape and expands it into importable files: an **Apple Health export** folder imports its `clinical-records/` FHIR and skips the multi-GB device exports (`export.xml`, `export_cda.xml`) and ECG/workout-route folders with a clear reason; any other folder is walked recursively for supported files (FHIR JSON, Turtle, C-CDA XML/zip). This is the first slice of the streaming-ingestion architecture: the container layer above the per-file FormatImporters. Verified on a real Apple Health export (1,267 files in, 1,160 records imported, both device exports skipped).

### Fixed

- **Import is resilient to a single bad file.** A file the converter cannot handle is now skipped with a reason in the import report, instead of aborting the whole import. Essential for folder imports of hundreds of files.
- **`contentHashedUri` coerces non-string content fields.** Real-world FHIR (an Apple Health Patient) could carry a non-string field where the URI derivation expected a string, throwing `v.trim is not a function`. Values are coerced with `String(v)`; the derived URI is unchanged for valid string inputs, so existing URIs are stable.
- **Whole-file read guard.** A file over ~2 GiB (Node's `fs.readFile` cap) is skipped with a clear reason rather than failing with an opaque "Cannot read file." Streaming import will lift this.

---

## [0.6.1] - 2026-06-23

### Fixed

- `cascade pod resolve` now honors the global `--json` flag. It emits a single machine-readable result object (`{ resolved, conflictId, keep, resolution, keptRecordUri, discardedRecordUris, remainingConflicts }`) and JSON-shaped errors, instead of human-readable text. It was the only `pod` subcommand that ignored `--json`, which forced programmatic callers (the desktop apps) to parse a success string out of stdout. Human-readable output is unchanged when `--json` is not set.

---

## [0.6.0] - 2026-06-22

### Added

- **Append-only record-amendment commands.** Original Pod records are now never modified in place; every edit/delete is a new provenanced overlay resource written to a new `<pod>/annotations/` directory (one `.ttl` per kind) and auto-discovered by `pod query --all`. All writes route through the encryption chokepoint (ciphertext on disk when the pod is encrypted), mint `urn:uuid:` ids, stamp `dct:created`, tag `cascade:dataProvenance cascade:SelfReported`, and are SHACL-validated before they are written (a malformed overlay fails and nothing is persisted). New subcommands:
  - `cascade pod amend <pod> --record <uri> --property <curie> --value <val> [--reason] [--by]` writes a `workbench:Amendment` (overrides one property value). Result: `{ amended, amendmentUri, recordUri, property, value }`.
  - `cascade pod annotate <pod> --record <uri> [--text] [--property --value] [--by]` writes a `workbench:Annotation` (adds a note / extra attribute). Result: `{ annotated, annotationUri, recordUri }`.
  - `cascade pod add-record <pod> --type <curie> --json '<propsJson>' [--by]` writes a NEW self-reported record into its canonical bucket (`clinical/...` or `wellness/...`) via the same type-to-file map `pod import` uses. `propsJson` is read from the argument or the `CASCADE_RECORD_JSON` env var. Result: `{ added, recordUri, type }`.
  - `cascade pod retract <pod> --record <uri> [--reason] [--superseded-by <keptUri>] [--by]` writes a `workbench:Retraction` (soft-delete / supersede). Result: `{ retracted, retractionUri, recordUri, supersededBy }`.
  - `cascade pod erase <pod> --record <uri> --confirm [--reason] [--by]` HARD-deletes: removes the subject from its bucket file, computes the sha-256 `contentHash` of its triples, and writes a `workbench:Tombstone` audit marker. Requires `--confirm`. The only records command that mutates a base bucket file. Result: `{ erased, tombstoneUri, recordUri, contentHash }`.
- `workbench:` is now a recognized Cascade namespace for vocabulary detection, so `cascade validate` applies the workbench shapes to overlay resources.

### Shapes

- Synced `workbench.shapes.ttl` from spec (`workbench@v1-draft.0.2`): SHACL shapes for `workbench:Amendment` / `Annotation` / `Retraction` / `Tombstone`. Per D-PATH, the draft is not registered as a `VOCAB_VERSIONS` row until v1.0 graduation.

---

## [0.5.11] - 2026-06-17

### Added

- **`cascade:AIExtractionActivity` now routes to `clinical/ai-extraction-activities.ttl`.** When `cascade pod import` ingests an AI-extraction Turtle batch (a clinical record plus the `cascade:AIExtractionActivity` it links to via `prov:wasGeneratedBy`), the activity node previously fell through to the `fhir-passthrough` bucket because it had no `DATA_TYPES` route. That mis-filed the activity as a FHIR resource and, as a side effect, wrote a `solid:forClass fhir:` registration into `settings/publicTypeIndex.ttl` using a `fhir:` prefix that file never declares, leaving the type index unparseable. The activity now has its own registry entry, so it lands in `clinical/ai-extraction-activities.ttl`, registers cleanly, and is queryable via `pod query --all`. (Needed by the Cascade Workbench document-extraction write path.)
- **`clinical:SocialHistoryRecord` now routes to `clinical/social-history.ttl`.** Same class of bug: social-history records had no `DATA_TYPES` route and fell to `fhir-passthrough`. They now route to their own file and register cleanly.

### Shapes

- Synced clinical v1.9 from spec (`vocab/clinical-v1.9`): every `dataProvenance` `sh:in` enum now includes `cascade:AIExtracted`, so a clinical record carrying AI-extraction provenance validates. `VOCAB_VERSIONS` clinical 1.8 -> 1.9.

## [0.5.10] - 2026-06-11

### Fixed

- **Reconciliation no longer drops non-reconcilable records.** `cascade pod import` reconciliation (multi-file or `--reconcile-existing`) silently discarded every subject outside the reconciler's known record types: `clinical:ClinicalDocument` narrative documents (with their `cascade:requiresLLMExtraction` flags), encounters, imaging studies, procedures, FHIR passthrough nodes, and untyped child nodes. Such subjects now pass through reconciliation verbatim, deduplicated by quad identity across inputs. The reconciliation report gains a `passthroughSubjects` count. (Found building the cascade-dmt demo; previously the only workaround was `--no-reconcile-existing`.)
- **Deterministic ClinicalDocument URIs for root-only document ids.** A C-CDA `<id root="..."/>` without an `extension` fell through to the import-timestamp fallback, so every re-import minted a new document URI and duplicated the document. Per HL7 II semantics the root alone is the document id; the timestamp fallback now applies only when the document carries no id at all.

## [0.5.9] - 2026-04-10

### Added

- `LICENSE` file (Apache 2.0). Previous published versions declared `"license": "Apache-2.0"` in `package.json` and listed `LICENSE` in the `files` array but had no `LICENSE` file in the repo, so npm packages shipped without one. This release ships the file.

---

## [0.4.0] - 2026-03-27

### Added

- `cascade convert --from c-cda` — native C-CDA R2.1 to Cascade Turtle converter. Handles IHE XDM zip bundles. Preserves CVX, LOINC, SNOMED, RxNorm, and ICD-10 codes from native C-CDA positions (no FHIR intermediary). Supports 12 section types: Allergies, Medications, Problems, Immunizations, Vital Signs, Results (Labs), Social History, Procedures, Encounters, Family History, Implanted Devices, and Plan of Care (narrative).
- Vendor detection and normalization: Epic MyChart (singleton-vs-array normalization, `urn:oid:` prefix handling) and Cerner PowerChart.
- `cascade pod import --reconcile-existing` — cross-batch deduplication. Loads existing pod records as a baseline before reconciling the new import batch. Makes repeated imports idempotent.
- `cascade pod conflicts <pod-dir> [--format text|json]` — read-only view of unresolved conflicts. Reads from `settings/pending-conflicts.ttl`. Exits 1 if any conflicts are present (CI-friendly).
- `cascade pod resolve <pod-dir> --conflict <id> --keep <source>` — records a conflict resolution decision to `settings/user-resolutions.ttl`. Stored resolutions are applied automatically on the next import.
- CDP-UUID deterministic IDs via `contentHashedUri()` — all record types now use content-hashed stable URIs derived from clinical identity fields. Re-importing the same clinical fact always produces the same URI.
- Document-type-aware deduplication thresholds: summarization documents (LOINC 34133-9) use a 0.50 similarity threshold; transactional records use 0.65.
- Patient profile deduplication: DOB + sex + name matching at 0.95 confidence; DOB-only fallback at 0.75.
- Immunization multi-tier matching: CVX + date (1.0), name + date (0.80), name-only (0.60).
- Vital sign reconciliation with LOINC + date matching and +/-5% / +/-15% value tolerance tiers.
- Conflict resolution persistence: `settings/user-resolutions.ttl` stores user decisions; re-imports apply stored resolutions automatically.
- `health:SocialHistoryRecord`, `cascade:UserResolution`, and `cascade:PendingConflict` vocabulary terms (synced from `spec/`).
- O(n*k) reconciler performance: type-indexed matching for cross-batch mode replaces the previous O(n^2) nested loop.
- `discardedRecordUris` fully deserialized from `settings/user-resolutions.ttl`.
- Conformance fixtures: CDP-UUID cross-SDK test vectors and C-CDA conversion fixtures.

### Changed

- `--reconcile-existing` is now `true` by default for `cascade pod import`. Disable with `--no-reconcile-existing`.

### Fixed

- `cascade convert` no longer mixes status messages with Turtle output on stdout. All progress/summary output is directed to stderr.
- `deterministicUuid()` algorithm fully documented with a cross-SDK test vector: `deterministicUuid("hello") === "aaf4c61d-dcc5-58a2-9abe-de0f3b482cd9"`.

---

## [0.3.6] - (previous release)

Previous release — see git history.

---

[0.4.0]: https://github.com/the-cascade-protocol/cli/compare/v0.3.6...v0.4.0
[0.3.6]: https://github.com/the-cascade-protocol/cli/releases/tag/v0.3.6
