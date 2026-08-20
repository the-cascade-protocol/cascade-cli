# Contributing to cascade-cli

`cascade-cli` is the reference implementation of the Cascade Protocol: it validates, converts, queries and manages local health data Pods, and it ships as `@the-cascade-protocol/cli`. Contributions here are typically a new `--from <format>` importer, a converter fix, a new command, or a shapes sync from `spec`.

## Before you start

- All open issues: <https://github.com/search?q=org%3Athe-cascade-protocol+is%3Aissue+is%3Aopen>
- Good first issues: <https://github.com/search?q=org%3Athe-cascade-protocol+is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22>

Open an issue before starting anything larger than a bug fix, so the approach can be agreed before the code exists.

## Development setup

**`conformance` must be cloned as a sibling directory**, not inside this one. Several suites resolve fixtures at `../../conformance/fixtures/`, and CI reproduces that layout exactly.

```
<parent>/
  cascade-cli/
  conformance/
```

```bash
git clone https://github.com/the-cascade-protocol/cascade-cli.git
git clone https://github.com/the-cascade-protocol/conformance.git
cd cascade-cli

npm ci          # not npm install, and never a symlinked node_modules
npm run build
```

Two further requirements:

- **Node 22.** The package declares `>=18`, but CI runs 22 and that is what the suite is measured against.
- **Apache Jena `riot` on `PATH`.** Five `*-conformance` suites canonicalize Turtle through `riot` via `execFileSync` for byte-equal comparison. Without it those suites fail rather than skip.

Install the hooks once: `sh scripts/install-hooks.sh`. The pre-commit hook blocks commits that change `src/shapes/` without updating `VOCAB_VERSIONS`.

## What must be green before review

```bash
npm ci
npm run build
npm test
```

`npm test` runs the full vitest suite. Two things to know about reading its output:

- **Green is not the same as complete.** A subset of suites is guarded by `describe.skipIf` and vanishes rather than fails when its inputs are absent, so a passing run can hide a suite that stopped executing. CI ratchets the skip count and fails in **both** directions: growth means something stopped running, and a decrease means a gap closed and the baseline must be lowered in the same change.
- **Build before you test.** Some tests spawn the built `dist/` output rather than the sources, so a change that is not built is not under test, and the suite can report green against code you did not run.

## Commit messages

```
feat(cli): <description>       # new command or behavior
fix(cli): <description>        # bug fix
chore(shapes): sync from spec  # shapes-only update from spec
```

## Opening a pull request

1. Branch from `main`.
2. Build, then run the full suite, and confirm the skip count did not move.
3. Update `CHANGELOG.md` and bump the version in `package.json` (patch for a shapes-only sync, minor for new CLI behavior).
4. Push and open a PR. `.github/PULL_REQUEST_TEMPLATE.md` fills in with the checklist; keep the items and tick them.
5. State in the PR body which suites you ran and on what Node version. If you could not run a suite (no `riot`, no sibling `conformance`), say so rather than leaving it implied.

### Adding a new `--from <format>` importer

1. Create `src/lib/<format>-converter/` with the converter logic.
2. Author a `registry-entry.ts` there exporting a `FormatImporter` const: `format`, `description`, `supportedOutputs`, `detect()`, `convert()`. Add `cliOptions` and `postProcess` only if you write sidecar files.
3. Append the import and the const to the `importers` array in `src/lib/import-registry.ts`. **Do not edit `src/commands/convert.ts`.** `--help`, format validation and content auto-detection all follow from registry inspection.
4. Adapt your converter's result to the unified `ImportResult` in `src/lib/import-types.ts`, populating `vocabularyGaps` and `importedIdentifiers`.

CLI flags in `cliOptions` must be globally unique across importers; the dispatcher errors at startup on a collision. A genuinely shared flag belongs as a top-level option in `convert.ts` instead.

## Vocabulary changes

**Vocabulary is never authored here.** `src/shapes/*.ttl` and `src/shapes/*.shapes.ttl` are copies from [`spec`](https://github.com/the-cascade-protocol/spec). To update them:

```bash
sh scripts/sync-shapes-from-spec.sh
git diff src/shapes/          # review what moved
```

Then update `VOCAB_VERSIONS` to the versions now embedded, and verify `cascade validate` passes against the current conformance fixtures.

If your change needs a new class or property that does not exist yet, it starts in `spec`. Read [`spec/CONTRIBUTING.md`](https://github.com/the-cascade-protocol/spec/blob/main/CONTRIBUTING.md) for the full seven-step propagation sequence; this repository is step 4 of it.

`deterministicUuid()` in `src/lib/fhir-converter/types.ts` is the canonical Cascade URI derivation algorithm. It is deliberately not RFC 4122 v5. **Do not change it without coordinating every SDK port**, because the same input must derive the same URI in all of them. Contract tests live in `tests/uri-generation.test.ts`.

## Protocol context

<https://cascadeprotocol.org/llms.txt> is the protocol index: install, quick start, data types, MCP server, security model, vocabulary versions, deployment sequence. About 95 lines, meant to be read in full.

Do not load `llms-full.txt` from that site. It is roughly 1.3 MB, larger than most working contexts, and as of 2026-08-20 its ontology section is known to be incomplete. Read the TTL files in `spec` instead.

## Questions?

Open an issue on this repository, or a [discussion on `spec`](https://github.com/the-cascade-protocol/spec/discussions) for questions about the protocol itself rather than the tool.
