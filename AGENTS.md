# AGENTS.md

CLI for validating, converting, querying and managing Cascade Protocol health data Pods. Ships as `@the-cascade-protocol/cli`.

## Start here

- `CLAUDE.md` -- architecture, the importer registry, the URI derivation algorithm, deployment discipline.
- `CONTRIBUTING.md` -- setup, what must be green, PR conventions, how to add an importer.
- `README.md` -- user-facing command reference.

`CLAUDE.md` and this file describe the same repository. `CLAUDE.md` is loaded automatically by Claude Code; this file exists so any coding agent finds the same instructions.

## Protocol context

<https://cascadeprotocol.org/llms.txt> is the protocol index: install, quick start, data types, MCP server, security model, vocabulary versions, deployment sequence. About 95 lines, meant to be read in full.

Do **not** load `llms-full.txt` from that site. It is roughly 1.3 MB, larger than most working contexts, and as of 2026-08-20 its ontology section is known to be incomplete. Read the TTL files in [`spec`](https://github.com/the-cascade-protocol/spec) instead.

## Ground rules

- **Never hand-edit `src/shapes/`.** Those files are copies from `spec`. Run `sh scripts/sync-shapes-from-spec.sh` and update `VOCAB_VERSIONS`. Vocabulary is authored in `spec` and nowhere else.
- **To add a `--from <format>` importer, append to `src/lib/import-registry.ts`.** Do not edit `src/commands/convert.ts`; help text, validation and auto-detection derive from the registry.
- **`deterministicUuid()` is a locked-in spec.** Changing it changes record identity in every SDK port at once. Coordinate before touching it.
- **Build before you test.** Some suites spawn the built `dist/` output, so an unbuilt change is not under test and the suite can report green against code it never ran.
- **`conformance` must be a sibling checkout**, at `../conformance`. Suites resolve fixtures through it, and without it they fail rather than skip.

## What must be green

```bash
npm ci                # never npm install, never a symlinked node_modules
npm run build
npm test
```

Requires Node 22 and Apache Jena `riot` on `PATH` (five conformance suites canonicalize Turtle through it).

Green is not the same as complete. CI ratchets the skip count and fails in both directions: a rise means a suite stopped running, a fall means a gap closed and the baseline must be lowered in the same change. If your run's skip count differs from CI's, find out why before claiming a pass.

## Conventions

- Commits: `feat(cli):`, `fix(cli):`, `chore(shapes): sync from spec`.
- Update `CHANGELOG.md` and bump `package.json` on any user-visible change.
- Branch from `main`; open a PR rather than pushing to it.
- Report what you could not verify (a suite you could not run, a dependency you lacked) in the PR body rather than only in a commit message.
