# cascade-cli — Agent Context

## Repository Purpose

CLI tool for validating, converting, querying, and managing Cascade Protocol health data Pods.
Package: `@the-cascade-protocol/cli`

## Key Architecture

- `src/shapes/` — Embedded SHACL shape files (copied from `spec/`). **Do not edit these manually.**
- `src/commands/` — CLI command implementations
- `src/lib/fhir-converter/` — FHIR R4 → Cascade Turtle conversion logic
- `src/lib/ccda-converter/` — Native C-CDA → Cascade Turtle converter (12 section handlers; vendor normalization for Epic/Cerner; IHE XDM zip support)
- `src/lib/reconciler.ts` — Semantic deduplication engine with type-specific matching (Patient, Immunization, Lab, Condition, Allergy, Medication, Vital Sign)
- `src/lib/user-resolutions.ts` — Conflict resolution persistence (`settings/user-resolutions.ttl`, `settings/pending-conflicts.ttl`)
- `src/lib/validator/` — SHACL validation against embedded shapes

## Key Commands Added in Phase 0–2 (EHR Import Plan)

- `cascade convert --from c-cda` — converts C-CDA XML or IHE XDM zip to Cascade Turtle natively
- `cascade pod import --reconcile-existing` — cross-batch deduplication: loads existing pod records before reconciling new import
- `cascade pod conflicts <pod-dir>` — lists unresolved conflicts; exits 1 if any (CI-friendly)
- `cascade pod resolve <pod-dir> --conflict <id> --keep <source>` — records a resolution decision to `settings/user-resolutions.ttl`

## Known Issues (as of 2026-03-27)

- **Reconciler is O(n²)** — `src/lib/reconciler.ts:502–525` uses nested for loops. Acceptable for small batches; will be slow for `--reconcile-existing` on large pods. Fix: build a keyed index for existing-pod records before the main loop.
- **`discardedRecordUris` not deserialized** — `src/lib/user-resolutions.ts:92` hardcodes `[]` when loading resolutions. Write path is correct; read path omits multi-record discard info.
- **`deterministicUuid()` is SHA-1 pseudo-v5** — Not RFC 4122 compliant. The algorithm must be documented precisely before SDK ports (Phase 3) can produce identical URIs.

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
