# cascade-cli — Agent Context

## Repository Purpose

CLI tool for validating, converting, querying, and managing Cascade Protocol health data Pods.
Package: `@the-cascade-protocol/cli`

## Key Architecture

- `src/shapes/` — Embedded SHACL shape files (copied from `spec/`). **Do not edit these manually.**
- `src/commands/` — CLI command implementations
- `src/lib/fhir-converter/` — FHIR R4 → Cascade Turtle conversion logic
- `src/lib/validator/` — SHACL validation against embedded shapes

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
