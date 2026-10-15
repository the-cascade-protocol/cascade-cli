# @the-cascade-protocol/cli

The reference command-line tool for the [Cascade Protocol](https://cascadeprotocol.org). It
converts health records from FHIR, C-CDA, Apple Health and genomics formats into RDF/Turtle,
validates them against the protocol's SHACL shapes, and keeps them in a local Pod (a folder of
Turtle files, optionally encrypted) that you can query, correct with a full audit trail,
deduplicate, and open to AI agents over MCP.

Everything runs on your machine. No command contacts a network to convert, validate, import,
query or write. The only commands that do are the ones you invoke by name for that purpose:
`advisory feed pull` fetches the URL you give it, `pod extract` posts narrative text to a
cascade-agent server (on your own machine by default), and `agent` sends your prompts, and the
output of the commands it runs, to the AI provider you configure.

## Installation

```bash
npm install -g @the-cascade-protocol/cli
```

Or run it without installing:

```bash
npx @the-cascade-protocol/cli validate record.ttl
```

Requires Node.js 18 or later (CI runs Node 22).

## Quick start

```bash
cascade pod init ./my-pod                          # create an empty Pod
cascade pod import ./my-pod patient-bundle.json    # FHIR, C-CDA, Turtle, or an Apple Health export
cascade pod info ./my-pod                          # record counts and sources
cascade pod query ./my-pod --medications --conditions
cascade validate ./my-pod                          # check every file against the SHACL shapes
```

`--json` goes before the command and makes any command's output machine-readable:
`cascade --json pod info ./my-pod`. `--verbose` works the same way.

## Commands

This section is an overview. Every command, flag and MCP tool is listed in the
[full command reference](https://cascadeprotocol.org/docs/guides/cli-commands.md), which is
generated for each release from the CLI's own `cascade --json capabilities` output, so it cannot
fall behind. `cascade <command> --help` shows the same thing locally.

### Top-level commands

| Command | What it does |
|---|---|
| `validate <file-or-dir>` | Validate Turtle against the Cascade SHACL shapes (`--shapes` for your own) |
| `convert [file]` | Convert one file between formats without a Pod (see [Formats](#formats)); reads stdin if no file |
| `reconcile <files...>` | Merge two or more loose Cascade Turtle files from different sources into one deduplicated record set |
| `pod <subcommand>` | Create and manage a Pod ([below](#pod-subcommands)) |
| `sources coverage <pod-dir>` | Report fields that were populated in the original source documents but not carried into the Pod |
| `serve --mcp` | Run the MCP server so an AI agent can read and write a Pod ([MCP](#connecting-an-ai-agent-mcp)) |
| `capabilities` | Describe every command and MCP tool (as JSON with `--json`) |
| `advisory <subcommand>` | Validate, preview, apply, list and revert Cascade Advisory Patches ([experimental](#advisories-experimental)) |
| `agent [prompt]` | Plain-English front end that runs `cascade` commands for you ([agent](#plain-english-agent)) |
| `conformance run` | Run the protocol conformance suite |

`reconcile` and `pod reconcile` are different commands. `reconcile` takes loose files and writes
the merged result to stdout or `--output`, touching no Pod. `pod reconcile` finds duplicates a Pod
already holds ([details](#reconciling-a-pods-own-duplicates)).

### Pod subcommands

| Subcommand | What it does |
|---|---|
| **Create and inspect** | |
| `pod init <dir>` | Create a new Pod (`--encrypt`, `--owner-name`) |
| `pod info <pod-dir>` | Show Pod metadata, record counts and sources |
| `pod profile set-name <dir> <name>` | Set the owner's display name |
| `pod doctor <pod-dir>` | Diagnose a damaged Pod; `--write` repairs what it safely can |
| **Data in and out** | |
| `pod import <pod-dir> <files...>` | Import files or folders, reconciling them against what the Pod already holds |
| `pod query <pod-dir>` | Read records by type (`--medications`, `--lab-results`, `--all`, ...) or by graph neighborhood |
| `pod export <pod-dir>` | Export the Pod as a zip or a directory |
| `pod extract <pod-dir>` | Send C-CDA narrative text to a cascade-agent server for AI extraction (`--dry-run` to preview) |
| **Correct records** | |
| `pod add-record <pod-dir>` | Add a new self-reported record |
| `pod amend <pod-dir>` | Override one property value on a record |
| `pod annotate <pod-dir>` | Attach a note or an extra attribute to a record |
| `pod retract <pod-dir>` | Mark a record as withdrawn or superseded by another |
| `pod erase <pod-dir>` | Permanently delete a record (requires `--confirm`) |
| **Duplicates and conflicts** | |
| `pod reconcile <pod-dir>` | Find duplicates already in the Pod; `--apply` merges, `--undo` reverses |
| `pod conflicts <pod-dir>` | List conflicts awaiting a decision (`--resolved` for the decision log) |
| `pod resolve <pod-dir>` | Record a decision on a conflict |
| **Encryption** | |
| `pod encrypt <dir>` / `pod decrypt <dir>` | Encrypt a plaintext Pod at rest, or decrypt it back |
| `pod passphrase set <pod-dir>` | Change the passphrase (`--rotate-dek` also replaces the data key) |

`amend`, `annotate` and `retract` never change the original record. Each writes an append-only
overlay beside it, with provenance, so every correction can be traced and the original is still
there. `erase` is the only command that removes data; it leaves a tombstone recording that the
erasure happened.

## Formats

`convert --from <format>` accepts:

| Format | Input |
|---|---|
| `fhir` | FHIR R4 JSON, a Bundle or a single resource |
| `c-cda` | HL7 C-CDA R2.1 XML, a single document or an IHE XDM zip |
| `cascade` | Cascade Turtle or JSON-LD, converted back to FHIR with `--to fhir` |
| `fhir-genomics` | HL7 FHIR Genomics Reporting IG bundle |
| `phenopacket` | GA4GH Phenopacket Schema v1/v2 |
| `vrs` | GA4GH VRS Allele JSON-LD |
| `clinvar` | ClinVar VCV XML |
| `vcf` | VCF 4.0 or later, plain or gzipped |

```bash
cascade convert --from fhir --to cascade patient.json > patient.ttl
cascade convert --from c-cda --to cascade summary.xml --source-system clinic-a
cascade convert --from cascade --to fhir patient.ttl
```

`--to cascade` and `--to turtle` both produce Turtle; `--format jsonld` produces JSON-LD instead.

`pod import` accepts FHIR JSON, Cascade Turtle, C-CDA XML or zip, folders of those, and an
unzipped Apple Health export (see
[docs/2026-09-25-apple-health-wellness-import.md](docs/2026-09-25-apple-health-wellness-import.md)).
To put genomics data in a Pod, convert it to Turtle first and import the result.

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
review and reaches `cascade pod conflicts`. A conflict under review is not a merge: both of its
records stay in the pod until someone answers it.

Answering a conflict is two steps, and the second is the one that changes the pod:

```bash
# Record the answer in settings/user-resolutions.ttl. Changes no record.
cascade pod resolve ./my-pod --conflict <id> --keep source-a

# Carry it out. `pod import` does the same on every import it reconciles.
cascade pod reconcile ./my-pod --apply
```

Recorded answers are an input to every reconciliation. An answered conflict is never raised again,
and a `source-a` / `source-b` answer is carried out as the same `workbench:Retraction` overlay
`pod retract --superseded-by` writes (in `annotations/retractions.ttl`), with `prov:wasDerivedFrom`
pointing at the answer that caused it. Both records stay; the one you chose against is marked as
superseded by the one you kept. The overlay is derived from the answer alone, so a second run writes
nothing, and the same records plus the same `settings/user-resolutions.ttl` give the same result in
any pod. `--keep both` keeps both records and supersedes neither.

An answer covers the records it was given about. A later record that matches the same pair (a third
source reporting the same medication) is a new question: it is raised against the records your
answers left standing, under an id of its own, and answering it adds a second decision. The decision
log holds one answer per conflict id, so answering the same conflict twice keeps only the last one,
and that is the one `pod conflicts --resolved` shows.

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
cleared because their records merged, cleared because you had already answered them, and orphaned
because their records are gone.

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

`pod query` answers with the pod's RECORDS. The pod's own bookkeeping about those
records — `cascade:PendingConflict`, `cascade:UserResolution`, `solid:TypeIndex`,
`solid:TypeRegistration`, `pim:ConfigurationFile` — is excluded from the record
output, because a note about two records is not a third record. Tooling that wants
the conflict queue asks for it:

```bash
cascade --json pod query ./my-pod --all --include-bookkeeping
```

A pod holding no bookkeeping produces byte-identical output with the flag and
without it. `pod conflicts`, `pod resolve`, `pod reconcile` and `validate` read the
settings files directly and are unaffected either way.

### Reading a pod with wellness data cheaply

An Apple Health import writes tens of thousands of daily wellness records and a
descriptor per retained sample pack. A reader that does not show them can leave
their files unread, not just unreturned:

```bash
# Every record except the wellness files and the sample-pack descriptors
cascade --json pod query ./my-pod --all --exclude-data-type wellness

# The stored daily wellness series and its per-source summary (one small file)
cascade --json pod query ./my-pod --wellness-series
```

`--exclude-data-type <key>` is repeatable. A key is a data type (the bucket keys
`--all` returns), `wellness-samples` (the retained-sample descriptors), or the
group key `wellness`: every data type whose file lives under `wellness/`, plus
`wellness-samples`. The group is read off the data-type registry, so it follows
the files, not a list. An unknown key is a usage error that lists the known ones. An excluded file is never
read, decrypted or parsed, by the record sweep, by `--edges` or by `--neighbors`.
Without the flag, output is unchanged. A key excludes its whole file, and some
files hold more than one kind of record: `heart-rate` also drops every
`health:VitalSignReading` the router files there by a heart-rate LOINC code
(clinical ones included), and `body-measurements` drops the VO2 max readings.
`wellness` drops all of those. It deliberately keeps `supplements`, which are
stored under `wellness/` too but are inputs to drug-interaction checks; exclude
`supplements` by name if you really want them gone.

`--wellness-series` adds `wellnessDailySeries` to the output (alone, or beside
`--all` in the same call): for each reading type and statistic, one reading per
local day, chosen by the source-priority rule (watch, then phone, then
third-party; within one source, the most recent import), each day citing the
record it was taken from; and per source, its devices and the days it covers per
reading type. It is a derived view the write verbs keep current, and every read
checks it against the files it was built from: a view they no longer match
comes back with `stale: true` and the reasons. See
[docs/2026-09-25-apple-health-wellness-import.md](docs/2026-09-25-apple-health-wellness-import.md#the-stored-daily-series-provisional-location).

The MCP server's `cascade_pod_query` tool takes the same options:
`excludeDataTypes` (an array of the same keys, `wellness` included) and
`wellnessSeries` (a boolean; the series comes back with its `stale` flag and
reasons). `dataType` is optional when `wellnessSeries` is true. An agent asking a
clinical question should pass `excludeDataTypes: ["wellness"]`; one asking a
wellness question should read the series rather than the records.

## Exit codes

Every command answers with one of three codes: `0` success, `1` user or input
error, and `2` **could not read what exists** — the pod, or a file inside it,
could not be opened, decrypted, or parsed. The third is the one that matters if
you script against this tool: an unreadable pod must never be mistaken for an
empty one. The codes, the `--json` error envelope, and the MCP equivalents are
documented in [docs/exit-codes.md](docs/exit-codes.md).

## Encryption at rest

A Pod can be encrypted with AES-256-GCM under a key wrapped by your passphrase:

```bash
cascade pod init ./my-pod --encrypt     # new encrypted Pod
cascade pod encrypt ./my-pod            # encrypt an existing plaintext Pod
```

The passphrase is read from `CASCADE_POD_PASSPHRASE`, or from a hidden prompt; it is never
accepted as an argument. Every other command opens an encrypted Pod the same way. The design,
the on-disk format, and passphrase changes and re-keying are documented in
[docs/pod-encryption.md](docs/pod-encryption.md).

## Connecting an AI agent (MCP)

`cascade serve --mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over
stdio. To add it to an MCP client such as Claude Desktop:

```json
{
  "mcpServers": {
    "cascade": {
      "command": "cascade",
      "args": ["serve", "--mcp", "--pod", "/path/to/my-pod"]
    }
  }
}
```

It exposes six tools: `cascade_pod_read`, `cascade_pod_query`, `cascade_validate`,
`cascade_convert`, `cascade_write` and `cascade_capabilities`. Records an agent writes are tagged
with AI-extracted provenance, and every MCP operation is logged to `provenance/audit-log.ttl` in
the Pod. `--transport sse --port <n>` serves the same tools over HTTP instead. The SSE server has
no authentication of its own, so it listens on `127.0.0.1` only and refuses requests addressed to
any other host name; anything running on your machine can still reach it, so prefer stdio.

## Advisories (experimental)

A Cascade Advisory Patch (CAP) is a signed update an issuer publishes about records a Pod may
hold, for example a reclassified genetic variant. The Pod owner decides whether to apply it, can
preview it first, and can roll it back:

```bash
cascade advisory validate advisory.ldpatch
cascade advisory dry-run advisory.ldpatch --pod ./my-pod
cascade advisory apply advisory.ldpatch --pod ./my-pod --signature advisory.jws --key <hex>
cascade advisory list --pod ./my-pod --pending
cascade advisory revert --pod ./my-pod --advisory <advisory-iri>
cascade advisory feed pull https://issuer.example/feed.jsonld --pod ./my-pod
```

The advisory vocabulary is still a draft in [`spec`](https://github.com/the-cascade-protocol/spec),
so the patch format may change between releases.

## Plain-English agent

`cascade agent` (provided by
[`@the-cascade-protocol/agent`](https://www.npmjs.com/package/@the-cascade-protocol/agent))
turns a request like "convert every FHIR file in ~/records and validate the output" into
`cascade` commands, showing each one as it runs. Run it with no prompt for an interactive
session, or pass a prompt for a single request.

```bash
cascade agent login                 # add credentials for a provider
cascade agent provider anthropic    # or openai, google, ollama
cascade agent "how many conditions are in ./my-pod?"
```

Unlike the rest of the CLI, the agent sends your prompts and the output of the commands it runs
to the provider you choose. With a hosted provider that can include health data from your Pod;
use `ollama` with a local Ollama server (its default) to keep everything on your machine.

## Development

```bash
npm ci
npm run build
npm run dev -- --help
npm test
```

The test suite needs sibling checkouts of `conformance` and `spec` and Apache Jena `riot` on your
`PATH`. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, what must pass before review, and how
to add a `--from` importer.

## License

Apache-2.0

This package ships code tables that reference external terminologies. Their
required attribution notices are in `THIRD-PARTY-NOTICES.md`, which is included
in the published package. In particular:

> This material contains content from LOINC (http://loinc.org). LOINC is
> copyright © Regenstrief Institute, Inc. and the Logical Observation Identifiers
> Names and Codes (LOINC) Committee and is available at no cost under the license
> at http://loinc.org/license. LOINC® is a registered United States trademark of
> Regenstrief Institute, Inc.
