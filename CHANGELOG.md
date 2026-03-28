# Changelog

All notable changes to `@the-cascade-protocol/cli` are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Fixed

- `cascade convert` no longer mixes status messages with Turtle output on stdout. All progress/summary output is directed to stderr.
- `deterministicUuid()` algorithm fully documented with a cross-SDK test vector: `deterministicUuid("hello") === "aaf4c61d-dcc5-58a2-9abe-de0f3b482cd9"`.

---

## [0.3.6] - (previous release)

Previous release — see git history.

---

[0.4.0]: https://github.com/the-cascade-protocol/cli/compare/v0.3.6...v0.4.0
[0.3.6]: https://github.com/the-cascade-protocol/cli/releases/tag/v0.3.6
