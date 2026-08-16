# @the-cascade-protocol/cli

Cascade Protocol CLI - Validate, convert, and manage health data.

## Installation

```bash
npm install -g @the-cascade-protocol/cli
```

Or use directly with npx:

```bash
npx @the-cascade-protocol/cli validate record.ttl
```

## Docker

Run the CLI without installing Node.js. See [DOCKER.md](DOCKER.md) for full details.

```bash
# Build the image
docker build -t cascade-protocol/tools .

# Validate a Turtle file
docker run --rm -v $(pwd):/data cascade-protocol/tools cascade validate /data/record.ttl
```

## Usage

```
cascade <command> [options]

Commands:
  validate      Validate Cascade data against SHACL shapes
  convert       Convert between health data formats
  pod           Manage Cascade Pod structures
  conformance   Run conformance test suite
  serve         Start local agent server
  capabilities  Show machine-readable tool descriptions

Flags:
  --help        Show help
  --version     Show version
  --verbose     Verbose output
  --json        Output results as JSON (machine-readable)
```

## Examples

```bash
cascade validate record.ttl
cascade convert --from fhir --to cascade patient.json
cascade pod init ./my-pod
cascade capabilities
```

## Reconciling a pod's own duplicates

`pod import` compares arriving records against stored ones, and never two stored records with each
other. So duplicates a pod already holds stay there. `pod reconcile` is the verb that finds them.

It reports first, and writes nothing until you say so:

```bash
# What WOULD merge. Reads the pod, changes nothing.
cascade pod reconcile ./my-pod
cascade --json pod reconcile ./my-pod
cascade pod reconcile ./my-pod --report duplicates.json

# Merge, having read the report above.
cascade pod reconcile ./my-pod --apply
```

Two organizations reporting the same lab result, at the same instant, with identical values, are
merged without raising a conflict. Every such merge is appended to `settings/tier0-merge-journal.json`
with the full content of the record it discarded. Anything less certain than that is reported for
review and reaches `cascade pod conflicts`.

Those merges are reversible, with the same report-first gate:

```bash
# What WOULD be restored from the journal. Changes nothing.
cascade pod reconcile ./my-pod --undo

# Put the records back, having read the report above.
cascade pod reconcile ./my-pod --undo --apply
```

The undo is itself journaled, by appending rather than by removing the merge it reverses, so running
it twice restores nothing the second time. A journal entry the pod has moved on from (a live record
already holding the IRI, or a bucket that no longer exists) is refused on its own, by name, while the
rest of the journal is replayed.

Every run also reports what it does to the review queue: how many pending conflicts were kept,
cleared because their records merged, and orphaned because their records are gone.

If a record file cannot be read, the command refuses to run at all (exit 2) rather than report counts
about a pod it only partly opened. The same holds for the review queue and the journal: a file that
exists and cannot be read stops the run rather than being overwritten unseen.

## Pod graph queries

A pod is a typed RDF graph. Beyond the flat per-type buckets of `pod query --all`,
two read-only flags expose the record-to-record edges (for example a lab report to
its results, or an explanation-of-benefit to its claim):

```bash
# The typed neighborhood of one record (stored edges traversed both directions)
cascade --json pod query ./my-pod --neighbors urn:uuid:<report-id>
cascade --json pod query ./my-pod --neighbors urn:uuid:<result-id> --hops 2
cascade --json pod query ./my-pod --neighbors urn:uuid:<report-id> --edge clinical:hasLabResult

# The record-to-record edge projection alongside the existing flat buckets
cascade --json pod query ./my-pod --all --edges
```

Both are additive and deterministic: `--all` without `--edges` is unchanged, and
the same invocation always produces byte-identical output. The JSON contract is
documented in [docs/2026-07-16-graph-query-json-shapes.md](docs/2026-07-16-graph-query-json-shapes.md).

## Exit codes

Every command answers with one of three codes: `0` success, `1` user or input
error, and `2` **could not read what exists** — the pod, or a file inside it,
could not be opened, decrypted, or parsed. The third is the one that matters if
you script against this tool: an unreadable pod must never be mistaken for an
empty one. The codes, the `--json` error envelope, and the MCP equivalents are
documented in [docs/exit-codes.md](docs/exit-codes.md).

## Development

```bash
npm install
npm run build
npm run dev -- --help
npm test
```

## License

Apache-2.0
