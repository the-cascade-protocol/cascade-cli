# cascade-cli — Agent Context

## Repository Purpose

CLI tool for validating, converting, querying, and managing Cascade Protocol health data Pods.
Package: `@the-cascade-protocol/cli`

## Key Architecture

- `src/shapes/` — Embedded SHACL shape files (copied from `spec/`). **Do not edit these manually.**
- `src/commands/` — CLI command implementations
- `src/lib/import-types.ts` — Shared `FormatImporter`, `ImportContext`, `ImportResult`, `VocabularyGap` interfaces. Source of truth for the importer contract.
- `src/lib/import-registry.ts` — Registry of all `--from <format>` importers. **To add a new format, append one entry here — do not edit `src/commands/convert.ts`.**
- `src/lib/fhir-converter/` — FHIR R4 → Cascade Turtle conversion logic
  - `registry-entry.ts` — `fhirImporter` (--from fhir) + `cascadeFhirImporter` (--from cascade --to fhir)
- `src/lib/ccda-converter/` — Native C-CDA → Cascade Turtle converter (12 section handlers; vendor normalization for Epic/Cerner; IHE XDM zip support)
  - `registry-entry.ts` — `ccdaImporter` (--from c-cda)
- `src/lib/reconciler.ts` — Semantic deduplication engine with type-specific matching (Patient, Immunization, Lab, Condition, Allergy, Medication, Vital Sign)
- `src/lib/user-resolutions.ts` — Conflict resolution persistence (`settings/user-resolutions.ttl`, `settings/pending-conflicts.ttl`)
- `src/lib/validator/` — SHACL validation against embedded shapes

## Adding a new `--from <format>` importer

1. Create `src/lib/<format>-converter/` with your converter logic.
2. Author a `registry-entry.ts` in that directory exporting a `FormatImporter` const. Implement `format`, `description`, `supportedOutputs`, `detect()`, `convert()`. Add `cliOptions` + `postProcess` only if you have sidecar files to write.
3. Append the import + the const to `src/lib/import-registry.ts`'s `importers` array.
4. Adapt your converter's internal result shape to the unified `ImportResult` (see `import-types.ts`). Populate `vocabularyGaps` and `importedIdentifiers` for genomics-era importers — these enable downstream gap reporting and reconcile.
5. The `--from <your-format>` value is now wired through `cascade convert` automatically. `--help`, format validation, and content auto-detection follow from registry inspection.

CLI flags declared in your `cliOptions` MUST be globally unique across all importers — the dispatcher errors at startup if two importers declare the same flag. If a flag is genuinely shared (e.g., a `--manifest` that every importer might emit), promote it to a top-level option in `convert.ts` instead.

## Key Commands Added in Phase 0–2 (EHR Import Plan)

- `cascade convert --from c-cda` — converts C-CDA XML or IHE XDM zip to Cascade Turtle natively
- `cascade pod import --reconcile-existing` — cross-batch deduplication: loads existing pod records before reconciling new import
- `cascade pod conflicts <pod-dir>` — lists unresolved conflicts; exits 1 if any (CI-friendly)
- `cascade pod resolve <pod-dir> --conflict <id> --keep <source>` — records a resolution decision to `settings/user-resolutions.ttl`

## URI Derivation Algorithm

`deterministicUuid()` in `src/lib/fhir-converter/types.ts` is the canonical Cascade URI derivation algorithm. It is intentionally not RFC 4122 v5 (no namespace UUID prefix) — treat it as a locked-in spec. **Do not change the algorithm without coordinating all SDK ports (TypeScript, Python, Swift).** Contract tests live in `tests/uri-generation.test.ts`.

## MANDATORY: Deployment Discipline

### Vocabulary files are owned by `spec/`

**Never edit `src/shapes/*.ttl` or `src/shapes/*.shapes.ttl` directly.**
These files are copies from `spec/ontologies/`. To update them:

```sh
sh scripts/sync-shapes-from-spec.sh
```

### When syncing updated shapes from spec:

- [ ] Run `scripts/sync-shapes-from-spec.sh`
- [ ] Review diff: `git diff src/shapes/`
- [ ] Verify `cascade validate` passes against new conformance fixtures
- [ ] Update `VOCAB_VERSIONS` to reflect the vocabulary versions now embedded
- [ ] Update CHANGELOG.md
- [ ] Bump version in `package.json` (patch for shapes-only; minor for new CLI behavior)
- [ ] Install hooks if you haven't: `sh scripts/install-hooks.sh`

The pre-commit hook will block commits that change `src/shapes/` without updating `VOCAB_VERSIONS`.

### Current vocabulary versions

Check `VOCAB_VERSIONS` at the repo root. Compare against `spec/VOCAB_VERSIONS` to see what's behind.

## Commit Conventions

```
feat(cli): <description>       # new command or behavior
fix(cli): <description>        # bug fix
chore(shapes): sync from spec  # shapes-only update from spec
```

## Related Repositories

- **spec** — Canonical source for all TTL/shapes/contexts. Only place vocabulary is authored.
- **conformance** — Test fixtures; validate CLI output against these before releasing.
- **cascadeprotocol.org** — Protocol documentation; syncs TTL from spec.
