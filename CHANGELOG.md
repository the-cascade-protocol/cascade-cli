# Changelog

All notable changes to `@the-cascade-protocol/cli` are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.15.0] - 2026-08-09

### Fixed

**C-CDA date properties are emitted as typed literals, at the precision the source stated.** Five
section handlers each sliced `<effectiveTime value="20250311"/>` down to `2025-03-11` with their own
copy of the same expression and wrote it with `literal(dateStr)`, which is a PLAIN literal and
therefore `xsd:string`. health 2.6 / clinical 1.14 constrain those properties to `xsd:date` or
`xsd:dateTime`, so every C-CDA-converted record carrying one failed validation on a date the
document had stated perfectly well. The sites now build the literal through one helper,
`src/lib/ccda-converter/dates.ts`, which reads the datatype off the source precision:

- `20250311143000-0500` becomes `"2025-03-11T14:30:00-05:00"^^xsd:dateTime`
- `20250311` becomes `"2025-03-11"^^xsd:date`

A day-precision value is not promoted to `T00:00:00`. Appending midnight would satisfy the datatype
check by asserting a time of day the source never gave, and a fabricated 00:00 is indistinguishable
downstream from a real one. A value coarser than a calendar day (`202503`) is not emitted at all,
because neither accepted datatype can express it. Affects `health:performedDate` (results,
procedures, and the vital-sign-to-lab fallback), `health:onsetDate` (problems) and
`health:administrationDate` (immunizations). Identity keys are untouched: they still read the
day-truncated string, so no record IRI moves.

**C-CDA record names are recovered from the section narrative when the structured code omits them.**
C-CDA lets an entry name its concept in the attested narrative and point at it from the structured
data (`<code><originalText><reference value="#result1"/></originalText>`) instead of repeating the
name as a `@displayName` attribute. The results, problems and procedures handlers read
`@displayName` only, so those records reached the pod with no name at all — and `health:testName`
and `health:conditionName` are `sh:minCount 1`, so each was invalid for missing a name the document
stated one dereference away. The resolver that `medications.ts` already carried privately moved to
`src/lib/ccda-converter/narrative-reference.ts`, unchanged, and the three sites call it. A
structured `@displayName` still wins where both are present.

When a reference does not resolve — no element declares that ID, or the element it names is empty —
nothing is emitted and the `minCount` violation stands, because it is then a true statement about
the document. Substituting a placeholder would turn a visible failure into a plausible-looking
record.

**FHIR `Observation.interpretation` codes are carried through instead of flattened.** The importer
mapped nine HL7 v3 codes onto four English words (H and L both to "abnormal", HH and LL both to
"critical") and wrote `unknown` for everything else — which is where susceptibility (S/I/R),
detection (POS/NEG/DET/ND), reactivity (RR/WR/NR) and change (B/D/U/W) results went. "The organism
is resistant to this antibiotic" and "the source reported nothing" arrived as the same string.
health 2.6 binds `health:interpretation` to that code system, so a code in the accepted set is now
written verbatim, and `unknown` means one thing: the source Observation carried no interpretation. A
code outside the accepted set keeps the previous nearest mapping and raises a warning naming the
code. The accepted set is a copy of the `sh:in` list in the bundled shapes, and a test reads the
shapes file and fails if the two ever disagree.

### Changed

`tests/known-shacl-gaps.ts` shrinks: the date-datatype gap it documented is closed by the emitter
fix above, so the two suites that referenced it assert zero violations again. The file now records
the one finding that remains — `clinical:ProcedureShape` requires `clinical:procedureName` while
`sections/procedures.ts` writes the name to `health:procedureName`, so a procedure record violates
the name constraint while carrying a name. Moving that predicate is a data change for every existing
consumer and wants its own release note, so it is pinned rather than folded in here.

### Verification

Full suite 133 files / 619 suites / 1983 tests, 0 failed, 0 skipped (from 130 / 602 / 1931 before).
Three synthetic C-CDA fixtures under `test-fixtures/` cover the date precisions, the resolvable
narrative references and the unresolvable ones; the typed-date fixture converts, imports and
validates through the CLI with zero violations.

## [0.14.0] - 2026-08-08

### Changed

**Bundled shapes synced to health 2.6 / clinical 1.14 / coverage 1.4 / checkup 3.3, so a conformant
FHIR record validates.** Real-world Epic FHIR exports, and C-CDA documents through the same
pipeline, were failing `cascade validate` on records that are correct at source. Every failure was a
Cascade constraint narrower than the standard the data had been converted from, not a defect in the
converter and not a defect in the data.

Measured on a synthetic Epic-shaped bundle carrying one susceptibility lab, one dual-coded
problem-list entry, one visit, one employer-sponsored policy and one Category III procedure: **7
violations and 1 warning before, 0 and 0 after**, and the Encounter went from "no applicable shape"
to checked. What the old shapes rejected:

- `interpretation` accepted five words invented in `spec` (normal / high / low / abnormal /
  critical). FHIR R4 binds `Observation.interpretation` to the HL7 v3 ObservationInterpretation code
  system, which also carries susceptibility (S/I/R), detection (POS/NEG/DET/ND/IND), reactivity
  (RR/WR/NR) and change (B/D/U/W) results. The converter writes the data-absent-reason code
  `unknown` when a source Observation carries no interpretation, and that was not in the enum
  either, so the single most common value in a real export was also a Violation.
- `labCategory` was single-valued while `Observation.category` is 0..\*, and `testCode`,
  `icd10Code` and `snomedCode` were single-valued while `CodeableConcept.coding` is 0..\*. Records
  were rejected for preserving what the source sent.
- `cptCode` required five digits, which is CPT Category I only.
- `coverageType` enforced a closed four-member enum at Violation severity on an element FHIR binds
  extensibly, and `subscriberRelationship` held five of the seven codes in the value set it points
  at.
- `clinical:Encounter` had no shape at all, so `validate` reported PASS on encounters having
  evaluated zero constraints. clinical v1.14 adds `EncounterShape` and `EncounterTemporalShape`.
- Date properties carried over from a source document now accept `xsd:date` as well as
  `xsd:dateTime`, because FHIR's `dateTime` primitive is explicitly partial-precision and C-CDA
  `effectiveTime` commonly states a calendar day and nothing more.

New `tests/fhir-standards-alignment.test.ts` converts that bundle through the real converter and
validates it against the real bundled shapes, asserting zero violations and full shape coverage. It
also pins what the converter EMITS, which is what separates "the shapes were widened" from "the
converter started dropping the values that used to fail". Verified RED against the previous shapes
before being kept: 3 of its 6 assertions fail there.

`tests/known-shacl-gaps.ts` is updated rather than deleted. It had argued that the C-CDA
day-precision emitters could not be fixed until the vocabulary decided how to express partial
precision; that decision is now made, in the direction it argued for. The gap it records is smaller
and sharper: the five emitters write a PLAIN literal, which is `xsd:string`, and `xsd:string` is
neither `xsd:date` nor `xsd:dateTime`. Typing the literal `xsd:date` now validates with no invented
time and no further shape change. That emitter fix is still deliberately out of scope for a
vocabulary sync.

Not synced in this pass: the sync script also produces diffs for the draft `evidence.ttl` and
`genomics.shapes.ttl`, which are pre-existing drift from spec's 2026-08-03 Validation Profile
release. They are left for their own sync so that a genomics `sh:class` semantics change is not
folded into a clinical alignment.


**`cascade capabilities` is generated from the command registry instead of being maintained by
hand.** The document is what an AI agent reads to learn what this CLI can do, and the hand-written
version described 12 of the 34 invocable commands: every write verb and every recovery verb was
invisible, including `pod doctor`. It also listed 12 of `pod query`'s 23 options, so whole queryable
data types (`--insurance`, `--claims`, `--benefits`, `--documents`, `--lab-reports`, `--imaging`,
`--devices`, `--medication-administrations`, `--fhir-passthrough`) and the graph surface
(`--neighbors`, `--hops`, `--edge`, `--edges`) could not be discovered at all.

All 40 registered commands and command groups are now described, with every argument, option,
default and choice list read from the registry that `cascade` parses with. Examples, output schemas
and safety semantics remain hand-authored in a decoration table that can only add to a command the
registry produced — it cannot introduce one. `--json` and `--verbose` are described once as root
options rather than repeated per command, with a correct statement of where they may appear.

### Fixed

- **`cascade capabilities` advertised an MCP tool, `cascade_pod_import`, that has never existed.**
  Both capabilities documents now derive their tool list from `registerTools`, so the advertised set
  cannot differ from the registered set.
- **The `cascade_capabilities` MCP tool reported `version: "0.2.0"`** while the package was on
  0.13.0. Both documents now read the version from `package.json`.
- **`pod doctor`'s description claimed `--json` had to be placed before `pod`.** Root options are
  accepted in any position.
- **The document claimed the CLI makes zero network calls** (backlog 3.34), in both
  `securityModel.networkCalls` and the top-level description, while `advisory feed pull` fetches the
  feed URL it is given and `pod extract` posts narrative text to the local cascade-agent. The claim
  survived partly because neither command was described here. Both are now named as the exceptions,
  and a test greps `src/` for outbound calls so a third one cannot appear while the claim stands.
  The MCP server's own document keeps a zero-network claim, now scoped to the tools it exposes,
  which is true: none of the six touches the network.
- **`cascade serve` was described without the word MCP, and `--mcp` was shown as optional.**
  Commander's one-liner is "Start local agent server" and the flag is enforced in the action handler
  rather than by the parser, so a purely generated entry told agents that `cascade serve` starts the
  server. It exits 1. `serve`, `conformance run`, `pod annotate` and `pod add-record` all enforce
  requirements the parser does not, and each now states its own in `notes`; the document explains
  that `required` reflects parse-time enforcement only.

## [0.13.0] - 2026-08-08

**Upgrade from 0.12.0 is recommended for anyone who has ever added a record by hand to a pod they
imported into.** That combination could leave a bucket unreadable, and a later import could then
replace it. Both are fixed below, and `pod doctor` repairs pods already affected.

### Added

**`cascade pod doctor <pod-dir> [--write]` — a recovery path for a pod the write commands refuse.**
Scans every `.ttl` file in a pod and repairs the ones whose only defect is that the header is
missing `@prefix` declarations the body uses — the damage the `pod add-record` bug below produced.
Everything else is reported with a next step rather than repaired.

It is a dry run by default; `--write` is required to change anything. A repair only ever PREPENDS
the missing declarations, so every existing byte survives verbatim and the command is safe on the
comment-anchored scaffolding files (`settings/publicTypeIndex.ttl`, `index.ttl`, `profile/card.ttl`,
`profile/extended.ttl`) as well as on record buckets. The repaired text must pass a strict parse
before it is written, the original is backed up beside the file as `*.doctor-backup` and restored if
the post-write read-back does not verify, and a prefix the tool does not know is a refusal naming
the prefix — it will never invent a namespace. Encrypted pods are handled transparently and stay
ciphertext.

Reported but deliberately not repaired, because each needs a human decision: empty and truncated
files (an interrupted write leaves both), IRIs holding a character Turtle forbids, and resources
that do not decrypt — the last of which says so plainly instead of blaming a passphrase that
demonstrably worked on the rest of the pod.

Exit codes follow the existing convention: `0` when nothing is wrong or everything found was
repaired, `1` when damage remains, `2` when the pod itself could not be opened. `--json` prints a
report distinguishing repaired / repairable / refused / unreadable with a per-file reason.

### Fixed

**`pod add-record` no longer destroys prefix declarations it did not author.** Adding a record to a
bucket an importer had written stripped every `@prefix` line out of the file and re-emitted a
narrower header of its own, deleting the `rxnorm:`, `sct:`, `loinc:`, `fhir:` and `vcard:`
declarations while keeping the CURIEs in the body that used them. The file stopped parsing, and
because one unreadable bucket fails the whole-pod read, `pod query` and `pod info` failed for the
entire pod. A pod that had imported medications and then had one record added by hand reported
`Undefined prefix "rxnorm:"` and could not be read at all. The same command also bricked a pod with
no import involved, by accepting a `core:` CURIE it never declared.

**An unparseable bucket is no longer silently replaced by the next `pod import`.** Import caught the
parse failure, treated the file as empty, and wrote over it — so a bucket with a damaged header lost
every record it held, at exit 0, reported as a normal import. The same command on its default flag
path instead died with an uncaught parser exception and a stack trace. Both paths now refuse that
single bucket by name, exit non-zero, leave the file byte-unchanged, and continue writing the
healthy buckets in the same import.

**`pod erase` no longer rewrites relative IRIs in records it was not asked to touch.** Erasing one
record rewrote the surviving records' `prov:wasAttributedTo </profile/card.ttl#me>` to
`<undefined/profile/card.ttl#me>`, silently corrupting patient attribution. `pod import`'s merge
path did the same and additionally demoted the term from an IRI to a string literal.

**`pod add-record` validates `--by` values and property CURIEs before writing.** A value containing
a character that cannot appear in an IRI produced an unparseable bucket at exit 0; it is now
rejected with a message naming the offending value.

### Changed

Every record-data merge (`pod add-record`, `pod import`, `pod erase`, and the amend/annotate/retract
overlays) now writes through a single graph re-serializer rather than by manipulating Turtle text.
The writer owns the whole document including its header, and emits a full `<IRI>` for any namespace
it has no prefix for, so a bucket carrying an undeclared CURIE can no longer be produced. The
prefixes a file already declared are preserved, so a bucket keeps the prefix names it was written
with. Human-curated files (`settings/publicTypeIndex.ttl`, `index.ttl`, `profile/card.ttl`,
`profile/extended.ttl`) are deliberately not routed through it and are unchanged.

**Upgrade note.** A bucket already damaged by the first bug above will now be refused by
`add-record`, `erase` and `import` rather than silently appended to or overwritten. That is
deliberate — the previous behaviour is what turned a broken header into lost records — but it means
an already-damaged file must be repaired before those commands will touch it. The records themselves
are intact; run `cascade pod doctor <pod-dir>` to see what is wrong and `--write` to restore the
missing `@prefix` lines.

## [0.12.0] - 2026-08-04

**If you are upgrading from 0.10.0, this release also contains everything described under 0.11.0
below.** 0.11.0 was tagged in git but never published to npm, so 0.12.0 is the first release since
0.10.0 that you can install. Read the 0.11.0 notes too: that is the release that changed how record
IRIs are derived, and re-importing a document you have already imported will behave differently
because of it.

### Changed

**Vocabulary and shapes synced to core v3.4, health v2.5 and clinical v1.13.** health v2.5 defines
five record classes the CLI has been emitting for a long time without any definition or constraint
behind them — `health:LabResultRecord`, `health:AllergyRecord`, `health:ConditionRecord`,
`health:ImmunizationRecord`, `health:FamilyHistoryRecord` — and gives each a SHACL shape. clinical
v1.13 deprecates the four duplicated `clinical:*` equivalents (they are not removed, and nothing
stops emitting them) and adds a shape for consultation notes, which were the one document subtype
validating against nothing. core v3.4 models the pod export manifest on
[DCAT 3](https://www.w3.org/TR/vocab-dcat-3/) and [VoID](https://www.w3.org/TR/void/).

**Records that used to validate against nothing are now actually validated, and some of them will
report findings. That means the validator improved, not that your data degraded.** These records
have not changed. Before this release, `cascade validate` had no constraints for them, and a SHACL
report over zero constraints conforms — so they were reported as passing without being examined.
Concretely, on the 19-file reference pod the number of Cascade-typed subjects that no shape applied
to falls from **122 to 1**, and subjects actually checked rises from **156 to 277** of 448. The
reference pod reports zero violations after the change; a pod carrying data the new shapes disagree
with will report violations it did not report before, and those findings were always true.

A worked example of what this buys, because it is not paperwork: a single bundle carrying two
same-day glucose readings — a fasting 95 and a post-prandial 310, an entirely routine pairing —
produced ONE subject asserting both `health:resultValue "95"` and `health:resultValue "310"`.
`cascade validate` returned PASS on that, because nothing constrained the cardinality, and reading
it back gave `"health:resultValue": "95, 310"`, a single string no consumer can interpret. The
`sh:maxCount 1` on the new lab shape catches it at write time.

**Known finding after upgrading: three date properties.** The C-CDA converter reads
`<effectiveTime value="20250311"/>` and writes `2025-03-11` as a plain string literal on
`health:performedDate`, `health:onsetDate` and `health:administrationDate`. All three are declared
`rdfs:range xsd:dateTime` and are now constrained with `sh:datatype xsd:dateTime`, so C-CDA imports
will report violations on them. The constraint is not new and not an overreach — it is the same one
`clinical:onsetDate` has always carried — but the emitters have disagreed with it for as long as
they have existed and nothing was checking. It is deliberately not patched in this release: the
source carries DAY precision, and typing it as `xsd:dateTime` means appending `T00:00:00`, which
invents a time that downstream date arithmetic will treat as real. FHIR R4's `dateTime` primitive
accepts `YYYY-MM-DD` precisely to avoid that, so the correct fix is a vocabulary change first and
an emitter change second, in a release of its own.

**`cascade validate` now reports how many subjects it actually checked.** Before this change it
returned PASS on records it had no constraints for, and there was no way to tell the difference
from the output. A file whose subjects match no `sh:targetClass` runs zero constraints, and a
SHACL report over zero constraints conforms — so "PASS" meant "nothing was found wrong", which
is not the same as "this was checked".

Every result line now carries a count:

```
PASS clinical/medications.ttl (192 triples; 8 of 8 subjects checked)
PASS clinical/lab-results.ttl (187 triples; 0 of 11 subjects checked; 11 subjects of type
     health:LabResultRecord had no applicable shape)
```

and a directory validation ends with a pod-wide `Coverage:` line naming every type no loaded
shape applies to. The same figures are available under `coverage` in `--json` output.

**If your validation output changes after upgrading, the validator got more accurate — your data
did not get worse.** Nothing that passed before now fails: unshaped subjects are counted and
named, but they do not affect the exit code, because a class with no shape is a gap in the
vocabulary rather than a defect in your data. On a 19-file reference pod this surfaced 292
previously unreported subjects, 122 of them carrying Cascade-namespace types, that were being
reported as passing while nothing ran against them. The vocabulary sync in this same release then
closes 121 of those 122; what remains unshaped is almost entirely subjects typed only in foreign
vocabularies (`prov:`, `fhir:`, `solid:`, `foaf:`, `ldp:`), which Cascade shapes are not written to
constrain.

### Fixed

- **`Shapes:` no longer names shape files that ran nothing.** The reported shapes were derived
  from which vocabulary prefixes a file declared, so a file using `health:` predicates printed
  `Shapes: health.shapes.ttl` even when no shape in it targeted any subject present. Reporting is
  now derived from the shapes that actually selected a focus node. A conditions file that
  previously listed three shape files now correctly lists none, and `--json` gains `shapesFired`
  naming the individual shapes that ran.
- **Class targets now honour `rdfs:subClassOf`.** Shape applicability is resolved per
  [SHACL 2.1.3.1](https://www.w3.org/TR/shacl/#targetClass), so a shape targeting a superclass is
  correctly reported as covering subclass-typed subjects, transitively. Nodes reached through a
  parent shape's `sh:node` are counted as checked rather than reported as unconstrained.
- **A file whose only findings are advisories is no longer counted as failed.** `sh:conforms` is
  false whenever a SHACL report carries any result at all, including `sh:Info`, and the summary was
  reading it directly — so a file with zero violations and one Info advisory printed `WARN` and was
  tallied under **failed**, while the exit code (computed from violations alone) said 0. On a pod
  with no defects the summary read `19 total, 15 passed, 4 failed` and the process exited 0, so one
  of the two was always lying. A file now fails if and only if it carries at least one
  `sh:Violation`; warnings and info are printed per file and counted on the `Issues:` line but do
  not move the pass/fail column, which is what makes the tally and the exit code agree. The same pod
  now reports `19 total, 19 passed, 0 failed` with `4 info`.
- **The vocabulary sync script only ever copied half of what it should have.** It kept two separate
  lists: one naming the vocabularies whose `.shapes.ttl` to copy, and one naming the vocabularies
  whose ontology to copy. The second list had three entries and never grew. `health.ttl` had
  therefore never been synced at all — 928 lines against the 1489 it should have been — and
  `checkup`, `pots` and all four draft vocabularies had no ontology bundled either. The measured
  consequence: **52 of 89 `sh:targetClass` values in Cascade namespaces resolved to a class that the
  CLI's own loaded vocabulary did not define**, meaning the validator was loading shapes that could
  select nothing and report nothing, silently. The script now drives both files from one list per
  maturity tier and exits non-zero if any expected file is missing, and `tests/shapes-sync.test.ts`
  asserts the invariant directly: every Cascade-namespace `sh:targetClass` in the bundled shapes
  must resolve to a class defined in the bundled vocabulary, every shapes file must have a matching
  ontology, each `VOCAB_VERSIONS` row must equal the `owl:versionInfo` of the ontology actually
  bundled, and `dist/shapes` must match `src/shapes` byte for byte.
- **Family-history records no longer land in the FHIR passthrough bucket.**
  `health:FamilyHistoryRecord` was registered in no data-type entry, so import routing fell through
  to its unmapped-type branch and every family-history record a C-CDA import produced was written to
  `clinical/fhir-passthrough.ttl` instead of `clinical/family-history.ttl`. Nothing looked wrong:
  the import succeeded and the section summary counted the records. They were simply filed under
  "type we could not map", which is the one bucket a reader is entitled to skip — and the class now
  has a ratified shape whose consumers look for the file that did not exist.

## [0.11.0] - 2026-08-03

**This release is about record identity — the IRI each record gets, which decides whether a
re-import updates a record or duplicates it, and whether two records stay two records.** Three
things changed. The first two pull in opposite directions, so it is worth being clear which is
which:

1. **Records the source never identified used to get a RANDOM IRI**, so re-importing the same
   document duplicated them, forever. They now get an IRI derived from their own content, so
   they reconcile. **No IRI that a source identifier already determined moves because of this.**
2. **Many kinds of record were identified too coarsely, and ignored the identifier their own
   source assigned them** — lab results by patient, test code and calendar day; conditions,
   allergies, immunizations and patient profiles by a similarly short list; and on the C-CDA
   path, EVERY record type, because the identifier was passed in a position the code reads only
   when nothing else is present, and something else always was. So two genuinely different
   records merged into one and one of them was silently lost. Fixing that necessarily moves
   those IRIs. **These are the release's IRI-breaking changes**, and the upgrade notes below
   say what to do about them.
3. **Whole clinical sections were never imported at all**, and this is not an identity change.
   On a C-CDA document whose custodian organization named a recognized EHR vendor — which is
   what a downloaded portal export is — **lab results, vital signs, family history and
   implanted devices each imported as ZERO records**, and the import reported success. On every
   document, vendor-recognized or not, an allergy written in C-CDA's standard nesting produced
   no record, and a procedure produced a record with no name, date or code. All of these are
   fixed here. **So expect your record count to go UP after re-importing, not merely to see
   IRIs move.** See Fixed, below, and the note on what is still not imported.

### Upgrade notes

- **Breaking for lab results, from EVERY import source.** Lab result IRIs change in this
  release, whether the results came from a FHIR source (a SMART on FHIR connection, a FHIR
  bundle, an Apple Health export) or from a downloaded C-CDA document (a MyChart-style portal
  export). If you have imported labs with an earlier version, records imported by this one
  will not match them.

  What was wrong: a lab result's identity was built from the patient, the test code and the
  calendar DAY, and from nothing else. The measured result was not part of it, the time of day
  was thrown away, and the lab's own identifier from your provider's system was ignored. So two
  different results for the same test on the same day — a fasting glucose in the morning and a
  post-prandial one before lunch — were treated as one record, and one of the two values was
  silently discarded. Which one survived depended on the order the files happened to be read
  in. Serial same-day labs are ordinary medicine (glucose curves, troponin series, repeat
  potassium, before-and-after dialysis), so this did not need unusual data to happen.

  **Both importers carried the same defect, in the same shape, and both are fixed here** —
  together, deliberately, so that lab identity changes exactly once rather than once per
  importer across two releases.

  A lab result now takes its identity from the identifier your provider's system assigned it,
  the same way vital signs already did. When a result carries no identifier, its identity comes
  from the patient, the test code, the FULL timestamp and the measured value, plus the specimen
  and category where the source records them — everything that actually tells two results
  apart.

  **What to do.** Re-import the sources your labs came from, into a fresh pod, and use that.
  Alternatively, keep the pod you have and accept that labs imported before and after this
  release sit side by side as separate records. Records that were merged by the old behavior
  cannot be recovered from the pod — the discarded value was never written — so a re-import
  from the original source is the only way to get them back.

  Measured on the published FHIR Genomics IG example bundles that ship with the conformance
  fixtures: 16 groups of records, 49 records in total, shared an IRI with a record they
  differed from — including six distinct HLA observations collapsed onto a single identity.
  After this change no lab observation collides with another; the only records that still
  share an IRI are the same record appearing in two files, which is correct.

  **What this particular change moved.** Across the FHIR conformance corpus, 46 of 91 converted
  resources were unchanged by it and every one of the 45 that moved was a lab observation;
  across the C-CDA corpus, 40 of 43 identities were unchanged and all 3 that moved were lab
  results. Four more FHIR record types move for their own reason, described in the next note,
  and the whole C-CDA path moves for a third reason described in the note after that.

  **Lab PANELS keep their IRIs, with one narrow exception.** A panel read from a C-CDA document
  whose source gave it neither an identifier nor a test code was previously indistinguishable
  from any other panel drawn for the same patient on the same day, so several genuinely
  different panels shared one record and pooled their results. Such a panel now takes its
  identity from its full timestamp and the set of results it contains, and so moves. A panel
  that carries an identifier — the common case — is unchanged.

- **Breaking for conditions, allergies, immunizations and patient profiles, from FHIR
  sources.** These four kinds of record change IRI in this release, for the same reason lab
  results do and as part of the same one-time change. If you have imported them with an earlier
  version, records imported by this one will not match them.

  What was wrong: each was identified by a short list of fields and by nothing else — a
  condition by patient, one SNOMED code, one ICD code and a calendar day; an allergy by
  patient and a single code read WITHOUT the coding system it came from; an immunization by
  patient, a similarly system-blind vaccine code and a calendar day; a patient by birth date,
  sex, surname and FIRST given name. And in all four, the identifier the source's own system
  had assigned the record was passed in a position the code only reads when every one of those
  fields is empty, which never happens on a real record. So the identifier was discarded on
  every record that carried one, and two records the source had deliberately kept apart became
  one.

  What that cost, concretely:

  - A penicillin allergy recorded as a **mild rash** and one recorded as an **anaphylaxis**
    were one record, and which survived depended on the order the files were read in. Nothing
    about the reaction was part of the identity at all.
  - A condition marked **active and confirmed** and the same code marked **resolved and
    refuted** were one record, on the same terms.
  - Two immunizations of the same vaccine on one day — a **left-arm** and a **right-arm**
    injection, or a dose that was **given** and an entry saying one was **not done** — were one
    record. Lot number, dose, site, route and status were all outside the identity.
  - Two people sharing a first name, a surname, a sex and a birthday were one patient profile,
    and every record belonging to either of them hung off it. Medical record numbers, middle
    names and suffixes were not consulted.

  Each of these takes its identity from the source's identifier now. Where a record carries
  none, the identity is built from everything the importer stores about it, so two records that
  differ in anything the pod will show also differ in identity.

  **What to do.** The same as for lab results: re-import the sources into a fresh pod and use
  that, or accept that records imported before and after this release sit side by side.

  **The merge that was wanted still happens, one layer up.** Two exports of one person from two
  different systems now arrive as two records rather than one, and the reconciler merges them —
  matching a condition on its SNOMED code, an allergy on the allergen, an immunization on the
  vaccine code and date, and a patient on date of birth and sex. The difference is that the
  merge is now counted in the import summary, attributed to the sources it came from, and
  raised as a conflict when the two disagree, instead of happening inside a hash where nothing
  could see it. Measured: importing one person's records from two EHRs into one pod previously
  left TWO patient profiles and an unresolved conflict that `cascade pod conflicts` reported as
  an identity collision — a question invented by the identity layer about two records that were
  never ambiguous. It now leaves one profile and no conflict.

  Measured across the conformance fixture corpus, 121 FHIR resources: **18 moved** (7 patients,
  5 conditions, 3 allergies, 3 immunizations) and 103 were byte-identical. Groups of records
  sharing an IRI with a record they differ from fell from **9 covering 21 records to 6 covering
  13**, and all 6 that remain are the same record appearing in two fixture files, which is
  correct. The worst case in the corpus was in published HL7 example data: one stock example
  patient appears in three Genomics IG bundles under three different server-assigned ids, one
  of them carrying a donor-registry identifier the others do not, and all three collapsed onto
  a single profile — a merge across three documents decided by four demographic fields and
  nothing else, which no test noticed.

  **Nothing else moves ON THE FHIR PATH.** Vital signs, medications, procedures, encounters,
  documents, coverage and claims all keep the IRIs they had when they arrive as FHIR. Verified
  across the same corpus: every one of the 18 resources that moved was one of the four types
  named here. The C-CDA path is a separate matter and is covered by the next note.

- **Breaking for EVERY record type read from a C-CDA document.** If you have imported a
  downloaded portal export — a MyChart or HealtheLife C-CDA, or an IHE XDM zip of them — every
  record from it changes IRI in this release. Not one type: all of them. **Re-importing such a
  document will also produce MORE records than before** — substantially more, if your export
  came from a recognized vendor, because its lab results, vital signs, family history and
  implanted devices were previously dropped in their entirety; that is the third change above,
  and it is a recovery rather than a break.

  What was wrong, and why it was all of them at once: every C-CDA section built its record's
  identity from a list of fields that began with the DOCUMENT'S PATIENT, and passed the source
  record's own `<id>` in a position the code consults only when every one of those fields is
  empty. The patient field was never empty. So the identifier your provider's system assigned
  the record was read on no record at all — not "usually ignored", never read — at all ten
  places a C-CDA record gets an identity. Measured: two entries identical in every field except
  their `<id>` produced ONE record, in all ten sections, and one of the two was discarded.

  It also failed in the opposite direction, from the same cause. That patient field was not
  your patient identifier; it was a value derived from four demographic fields — birth date,
  sex, surname and FIRST given name. So one document recording "John" and another recording
  "Johnny", for the same person with the same medical record number, produced two different
  patient values, and every clinical record in both documents was re-identified along with
  them. Measured: a byte-identical procedure carrying the SAME source identifier became two
  records. So the same design both merged records your provider kept apart and split records
  that were the same.

  And on most real documents there was no identifier left to read anyway. C-CDA's ordinary form
  for a locally minted identifier is `<id root="9a6d1bac-…"/>` with no `extension` attribute,
  which is what Epic and Cerner emit, and nine of ten sections extracted an identifier ONLY
  when `extension` was present. On those records the identifier was discarded outright — which
  is also why `cascade:sourceRecordId` was missing from them, a loss visible in pod output
  today and not only in identity.

  What it is now: a C-CDA record takes its identity from the `<id>` its source assigned it, in
  all four of the forms a real export uses (root plus extension, extension alone, root alone,
  and several `<id>` elements where the first may be a `nullFlavor` placeholder). Where a
  record carries no identifier, identity comes from what the record IS — its codes, its full
  timestamp, its measured value and unit, and the other fields the pod will display. The
  derived patient value is in no key at all: within a pod it either never varies, and so told no
  two records apart, or varied, and every variation was one of the splits above.

  **The patient profile from a C-CDA now uses the medical record number.** It is in
  `patientRole/id` in every real export and was not consulted at all, so two different people
  sharing a birth date, a sex, a surname and a first given name were one profile. Where a
  document carries no MRN, the profile is identified by the whole name (every given name, not
  the first), the whole address and the contact details — all of which the pod displays and none
  of which were in the old key.

  **What to do.** The same as for the FHIR changes above: re-import your C-CDA documents into a
  fresh pod and use that, or accept that records imported before and after this release sit
  side by side. Re-importing the same document twice still produces one record set, before and
  after — that behaviour is unchanged and is held by a test.

  **The scale, measured.** Across the nine C-CDA documents in the conformance corpus and this
  repo's own fixtures, which convert to 56 records: **28 move and 28 do not.** The 28 that keep
  their IRIs are the 19 section-narrative document nodes and the 9 lab results that already
  carried an identifier — a lab result identified by its `<id>` mints exactly the IRI it did
  before, deliberately. Everything else moves: 9 patient profiles, 5 allergies, 5 lab panels,
  3 conditions, 3 immunizations, 2 medications and 1 encounter. Counted as distinct IRIs rather
  than per document, 17 of 44 move. **The FHIR import path is untouched by this change**: 266
  distinct IRIs across the same fixtures, 0 moved.

### Added

- **The import summary now states, per section, how many structured entries it read and how many
  records it wrote.**

  ```
  Structured sections (entries read -> records imported):
    - Allergies: 1 -> 0  <-- NOTHING IMPORTED
    - Family History: 2 -> 2
    - Results: 2 -> 9
    - Vital Signs: 1 -> 8
  ```

  A section that offers structured entries and produces no records is also named in the
  warnings, whatever the cause — a nesting the importer cannot read, a section type it does not
  support, or entries that were genuinely empty. Previously the summary printed a record count
  and a per-type breakdown that simply OMITTED the empty buckets, so an import that dropped four
  entire clinical sections was indistinguishable from one that dropped none. The numbers are in
  `--json` output and in `--report` as `sectionCensus`.

  This is reported on its own merits and independently of every fix below: had it existed, the
  section losses fixed in this release would have been visible the first time anyone imported a
  portal export.

### Known limitations in this release

- **An allergy whose allergen is named only in the section narrative is still not imported —
  but it is now reported.** Some exports code the allergen as absent (`<value nullFlavor="NI"/>`
  with a `<code nullFlavor=…>` whose `<originalText><reference value="#…"/>` points into the
  section's narrative table) and write the substance in words in the narrative only. The
  importer reads structured data, finds no allergen, and writes no record.

  That was silent. It is not any more: the entry is named in the warnings, with its source
  identifier, and the section census shows the section as `1 -> 0`. Recovering the substance
  itself — by resolving the narrative reference, and/or by emitting the record with a
  data-absent reason — is a separate change and is not in this release. **If your export
  records allergies this way, check the import warnings; those allergies are not in your pod.**

### Fixed

- **Lab results, vital signs, family history and implanted devices imported as ZERO records
  from any document whose custodian named a recognized EHR vendor.** This is the largest data
  loss fixed in this release and it affected the most common real input there is: a C-CDA
  downloaded from a patient portal.

  A repeatable C-CDA element — one the CDA R2.1 schema declares `0..*` — is an array when the
  importer forces it to be one and a plain object otherwise, and that forcing was decided in
  two places that did not agree. The XML parser forced thirteen element names on every
  document. Each vendor shim then forced a DIFFERENT set, on documents from that vendor only.
  `<organizer>` and `<supply>` were in the vendor lists and not the parser's.

  So `entry.organizer` was an object on most documents and an array on documents from a
  recognized vendor, and four section handlers read it as an object. Reading a property of an
  array yields nothing, so on those documents the results section, the vital signs section, the
  family history section and the medical equipment section each produced no records at all —
  and nothing said so. **The same document imported 30 records when its custodian was
  unrecognized and 10 when it named a vendor.**

  There is now ONE list of repeatable elements, applied by the parser to every document. Vendor
  normalization can no longer change the shape of anything, a test asserts that it does not,
  and a second test fails the build if any handler reads a property off one of these containers
  again. That last one is the point: this was the third time the same mistake shipped.

- **Allergies written in C-CDA's standard nesting were dropped entirely.** An allergy in a
  C-CDA document is normally recorded as a concern act wrapping the allergy observation
  (`act` → `entryRelationship` → `observation`), which is what Epic and Cerner emit. The
  importer only walked the looser `act` → `observation` shape, so on a standard document it
  produced NO allergy records at all — not a wrong allergy, none. Both shapes are read now.

- **Family history was dropped entirely, for two independent reasons.** The section handler
  read an organizer's component observations as a single object where the parser always
  produces a list, so every field came back empty. On a vendor-recognized document the
  organizer itself was also unreadable, for the reason above. Both are fixed; on such a
  document the first fix alone recovered nothing.

- **Procedure records were written with no name, no date and no code.** The handler read
  `entry.procedure` (and its `entry.act` fallback) as an object where both are always lists, so
  every field it went on to read came back empty — but nothing stopped it writing the record.
  A procedure therefore imported as a bare typed node with none of its content, on EVERY
  document. This was harder to see than the zero-record sections precisely because the record
  count looked right.

- **A resolved problem imported as active, on every document.** A problem's status sits in a
  status observation under `<entryRelationship>`, which is always a list; the handler read it as
  an object, so the status the source stated was never read and the displayed status fell back
  to the "active" default every time. A problem your provider marked resolved is now imported as
  resolved.

- **An allergy's severity, and the allergen name the source wrote for a human, were both
  discarded.** The severity observation sits under `<entryRelationship>` and the allergen name
  in `<playingEntity><name>`; both are lists and both were read as objects. The allergen fell
  back to the coded concept's display name, which names the same substance but is not the string
  your provider chose to show you, and the severity was simply lost. Measured across the C-CDA
  conformance fixtures: every allergy in the corpus had a severity in its source (mild, moderate
  and severe) and NONE of them reached the pod. Both are read now. Severity is part of an
  allergy's identity — a mild rash and an anaphylaxis to one substance are two claims — so an
  allergy that carries no `<id>` of its own moves; every allergy in the corpus carries one, and
  none of their IRIs move.

- **A drug named only in `<manufacturedMaterial><name>` fell through to the narrative and RxNorm
  fallbacks.** Same cause: `<name>` is a list and was read as an object.

- **A root-only `<id>` is no longer discarded, so `cascade:sourceRecordId` survives.** Nine of
  ten C-CDA sections read a record's identifier only when it carried an `extension` attribute,
  so `<id root="9a6d1bac-…"/>` — the ordinary form for a locally minted identifier — was thrown
  away and the record was stored with no `cascade:sourceRecordId` at all. This is the same fix
  as the identity change above and is listed separately because the loss was visible in pod
  output independently of identity.

- **Two C-CDA identity keys were missing the record's own source object.** The vital-sign
  observation re-routed to a lab result, and every medication, passed no source object to the
  last identity tier, so a record with nothing else to go on landed on a shared per-type
  sentinel instead of a hash of itself.

- **A missing drug name no longer merges unrelated medication records.** When a
  `MedicationStatement` or `MedicationRequest` named no drug, the importer substituted the
  literal text "Unknown Medication" and then used it to build the record's identity. Every
  medication with no name therefore got the SAME identity, so they merged into one record
  without warning. The substituted text is still what the record displays; it is no longer
  what the record is identified by, so such records now stay separate and, when they carry
  nothing at all to tell them apart, say so. **A medication that names a drug is unaffected
  and its IRI does not move.**

- **A collapse notice now names the resource type you imported.** Medications are identified
  under a single shared key regardless of which FHIR resource they arrived as, and the notice
  reported that shared key — telling someone who imported a `MedicationStatement` to go
  looking for a `MedicationRequest`.

- **A code the importer did not recognize no longer erases a record's identity.** A condition
  coded in anything other than SNOMED or ICD — a local hospital code, or nothing but the
  problem's name in `code.text`, which is ordinary in portal exports — contributed nothing at
  all to its own identity, so every such condition recorded for one patient on one day was one
  record. Allergies and immunizations had a narrower version of the same fault: they read only
  the FIRST code on the record and read it WITHOUT the coding system it came from, so two
  systems that happen to reuse a number were indistinguishable. All the codes now count, each
  paired with the system it belongs to.

- **A placeholder name is no longer part of what a record IS.** "Unknown Condition", "Unknown
  Allergen" and "Unknown Vaccine" are still what a record with no name DISPLAYS. Widening the
  identity keys above could have pulled them into identity, where a placeholder turns "we do
  not know" into "these are the same record"; the keys read the source's own fields instead,
  and a test now holds each of the three to displaying the placeholder while still telling the
  records apart.
- **Two records that share one subject IRI but disagree on content are no longer silently
  reduced to one.**

  Cascade subject IRIs are content-hashed, so the reconciler treated a second arrival of an
  IRI as a re-import of the same record and passed over it. That is right for a re-import
  and wrong for an identity COLLISION — two genuinely different records that an identity key
  narrower than the records themselves minted onto one IRI. A fasting glucose of 95 and a
  post-prandial of 310, drawn the same day, are exactly that shape, and serial same-day
  results are ordinary clinical practice (glucose curves, troponin series, repeat potassium,
  pre/post dialysis).

  The consequence was silent clinical data loss on the primary import path: one of the two
  values was discarded, the loss was reported as successful deduplication, no conflict was
  written, nothing was printed — and WHICH value survived was decided by the order the
  inputs happened to be enumerated, i.e. by the filesystem. The same two files imported on
  two machines could leave a normal glucose in one pod and a critical hyperglycemia reading
  in the other.

  The reconciler now compares the records behind a shared IRI:

  - **Identical content is still a re-import**, handled exactly as before. Per-run
    bookkeeping (`clinical:importedAt`, `cascade:reconciliationStatus`, merge lineage,
    ingestion source labels) is not content, and neither is the difference between a
    reference edge stored resolved in the pod and the same edge carried as an unresolved
    placeholder by a fresh conversion. Nothing here changes for an ordinary re-sync.
  - **Differing content is a COLLISION**, and it is split rather than merged: every distinct
    content keeps its own record. This follows the rule the identity layer already states —
    when identity is uncertain, prefer a split, because a duplicate is recoverable and a
    merge is not. The IRI the identity layer minted stays occupied by one of them, so
    nothing that referenced it starts dangling, and which one that is depends only on the
    records' own contents, never on input order. Reversing the input order now produces a
    byte-identical pod.
  - **The collision is raised as an unresolved conflict** through the existing queue:
    `settings/pending-conflicts.ttl`, `cascade pod conflicts` (which exits 1), and
    `cascade pod resolve`. The conflict names which predicates disagree. `pod import` prints
    a warning rather than reporting the collision as a duplicate, and the two split records
    are kept out of each other's match candidates for that run, so a question raised for a
    person is not answered by an automatic merge in the same breath.

  The import summary gains `identityCollisionsSplit`, and `duplicateSubjectsDropped` now
  means only what it says: a record the pod already held, byte for byte.

  **No IRI moves for any pod that has no collision in it.** Where a collision does exist,
  the record that previously survived keeps its IRI and the record that was previously
  DELETED reappears under a new derived one, so this recovers data rather than relocating
  it.

- **`src/lib/reconciler.ts` is searchable again.** It used NUL as a key delimiter written as
  a raw byte rather than as an escape, which made `file(1)` classify the source as binary
  and made `grep` and `ripgrep` skip all 1,339 lines of it without saying so — a content
  search returned "no matches" for symbols the file demonstrably contains. The three sites
  now use `\u0000`, which is the same string, and a test rejects a raw NUL anywhere under
  `src/`.

- **Re-importing a document no longer duplicates the records in it that carry no `id`.**
  This closes the known limitation named in 0.10.0.

  Every importer minted a subject IRI from the source resource's `id`, and when a resource
  had none, made one up: a random UUID on the FHIR clinical path, `Math.random()` in the
  genomics converters, and a per-run import timestamp in the phenopacket and C-CDA
  converters. Because a fresh IRI is indistinguishable from a new record, importing the same
  document twice produced a second copy of every id-less record in it, on every import,
  with no warning. `Resource.id` is optional in FHIR, so this was reachable from real
  payloads — transaction Bundles, contained resources, exported and hand-authored documents,
  and C-CDA files whose `ClinicalDocument` carries no `<id>`.

  Identity for these resources now comes from the resource's own content: the same record
  yields the same IRI across runs, across machines, across working directories, and
  regardless of its position in a bundle. Different records still yield different IRIs.

  **This change moves no IRI that a source identifier already determined** — see point 1 of
  the summary at the top of this section. Where a source resource carries an identifier, the
  IRI it produces here is byte-for-byte what previous versions minted. The lab-result change
  under Upgrade notes is a separate change and is the release's only IRI break.

  Server-assigned volatile fields are excluded from the content hash — `meta.lastUpdated`,
  `meta.versionId` and `meta.source` — so a resource re-fetched from an EHR keeps its
  identity even though the server stamped it with new metadata. Generated narrative (`text`)
  is excluded too wherever structured fields exist, since servers re-render it freely.

  **When identity is uncertain, this errs toward a duplicate rather than a merge.** A
  duplicate is recoverable: all the data is present and can be reconciled later. A merge is
  not: the second record's content is gone. So a resource with no structured content still
  takes its identity from its narrative — two Conditions whose only content is
  "Type 2 diabetes mellitus" and "Metastatic breast cancer" remain two records. The cost is
  that a server which re-renders such a narrative can produce a duplicate, which is the
  failure worth preferring.

  A resource with genuinely nothing — no id, no structured content, no narrative — does
  collapse onto a shared IRI, because there is no content to lose and splitting would mint a
  fresh IRI on every sync. That case now emits a warning naming what happened rather than
  passing silently.

---

## [0.10.0] - 2026-08-02

**If you are upgrading from 0.5.11, this release contains everything since.** 0.6.0, 0.6.1
and 0.7.0 were written up below but never published to npm, and the 0.8/0.9 line was never
cut at all, so the registry went straight from 0.5.11 to here. Their notes remain in their
own sections; this section covers the work that had not been released under any number.

From this release onward every publish is tagged `v<version>` on its release commit, so the
registry, `package.json` and the git tags cannot drift apart again.

### Upgrade notes

- **Breaking for genomics data only.** VCF import now derives `genomics:SequencingRun`
  identity from file CONTENT rather than the file's absolute path (see below). Variants and
  runs imported by an earlier version carry path-derived IRIs and will not match records
  imported by this one. Re-import affected VCFs, or accept that old and new records sit side
  by side. Nothing outside the VCF path changes identity.
- **`pod export` now refuses an encrypted pod** unless you pass `--allow-encrypted`. If you
  script exports of encrypted pods, add the flag; the export is stamped with a note
  explaining what the ciphertext is.
- **Read verbs now exit 2 when they cannot read a pod** instead of exiting 0 with an empty
  answer. If you consume this CLI programmatically, treat exit 2 as "could not read what
  exists", which is not the same as "nothing is there". The full contract is in
  `docs/exit-codes.md`.
- **`pod info` prompts for a passphrase** when run interactively against an encrypted pod;
  previously it read the environment only.
- **`pod extract` refuses its write path on an encrypted pod** rather than writing plaintext
  into a sealed one. Its read path works. See the known limitations below.

### Known limitations in this release

Stated plainly rather than discovered later:

- **`pod extract` cannot write to an encrypted pod.** Its five output files and the index
  append are still plaintext-only, so extraction is unavailable on encrypted pods and now
  refuses rather than corrupting. Tracked as backlog 3.68.
- **Identity minting is non-deterministic for source resources that carry no `id`.** Several
  importer paths fall back to a random value when a FHIR resource or phenopacket element has
  no identifier, so re-importing such a resource mints a new IRI each time instead of
  reconciling. FHIR servers assign ids to searched resources, so this is reached mainly by
  hand-authored, exported, or contained resources. The VCF path described below is now immune
  to this by construction. Tracked as backlog 3.74 and being addressed next.
- **`--json` success payloads state readability only on `pod info`.** Other read verbs report
  the negative case in the same vocabulary but do not state the positive one. Tracked as
  backlog 3.69.

### Added

- **One pod read layer, and a test that forbids going around it** (backlog 2.33). Encryption was retrofitted onto a CLI whose read verbs each walked the pod's files and parsed them independently, so the DEK was an argument every caller had to remember rather than a property of the open pod. Every verb had to be taught about it one incident at a time, and each one that had not yet been taught shipped the same lie: an encrypted pod reported as an empty one. A new module, `src/lib/pod-read.ts`, is now the single door. `openPod()` resolves the key ONCE per invocation (`CASCADE_POD_PASSPHRASE`, then a hidden TTY prompt when interactive, then a clean typed failure) and returns a `PodReader` through which every record read flows; a verb that forgets the key cannot be written, because no read call takes one. Failures are typed (`decrypt` / `parse` / `io`), each carrying the pod-relative path and a tidied reason, and `PodReadLedger` applies the weighting settled in the previous release so no caller restates it: a decrypt failure is ALWAYS fatal (the pod's key is wrong for that file and nothing about its contents is known), a parse failure is fatal only for a REGISTERED record file (`clinical/…`, `wellness/…`) and a loud warning for any other `.ttl` a pod holds (notes, analyses, literature, app resources), and an I/O failure is fatal. The pieces that used to be three separate spellings of the same idea are absorbed into it: `parseDataFile`, `readPatientProfile`, `resolvePodDekIfEncrypted`, the graph loader's `dek ? readResource : fs.readFile` branch, and the reporting helpers. The record-file registry moved to `src/lib/pod-data-types.ts` so the layer can consult it without importing a command module; `commands/pod/helpers.ts` re-exports both, so no existing import path changed. `tests/pod-read-layer-chokepoint.test.ts` greps `src/` and FAILS if `parseTurtleFile` / `parseDataFile` — or a hand-composed `parse*(readResource(...))` record read — appears outside a short, commented allowlist, so a new verb cannot quietly take the old path.

- **A verb-agnostic read-honesty battery** (backlog 2.33). Per-verb regression tests only ever protect the verb that already broke, and this class of bug arrived once per verb. `tests/pod-read-conformance.test.ts` builds ONE encrypted fixture pod and runs the same five-state matrix — correct passphrase, passphrase unset, wrong passphrase, one plaintext stray among sealed files, `settings/encryption.json` missing — across every read verb **by enumeration**: it walks the commander registry and fails if a registered `pod` subcommand is not classified in its table, so a new verb inherits coverage by existing rather than by someone remembering. The assertions are the contract: the correct passphrase produces real data (nonzero counts where the fixture has records), every unreadable state produces a nonzero exit naming the reason, and nothing ever exits 0 with an empty answer over a pod that has data. Exit codes are pinned with it — 0 success, 1 user/input error, 2 could not read what exists. The MCP read tools run the same matrix in-process. Verbs run as real subprocesses because some call `process.exit` directly and the exit code is the thing under test; the fixture re-wraps its own DEK under cheap Argon2id parameters so ~30 invocations cost seconds rather than minutes. 44 tests.

- **Full-scale Synthea bundle == split regression corpus**. R5's committed synthetic fixture (9 files) proves the once-per-invocation cross-file resolution mechanism, and the real Apple Health export measures the real source (which structurally carries no Encounter resource, so its `hasEncounter` answer is a permanent zero and it cannot be committed). This adds the missing integration-grade, PHI-free corpus with full relationship richness in the one-resource-per-file layout: a small committed splitter (`scripts/2026-07-23-split-fhir-bundle.mjs`) deterministically splits a FHIR Bundle into the Apple Health shape, and a new test (`tests/synthea-split-corpus.test.ts`) splits the committed Synthea specimen (Grant908_Haley279, 254 resources) at test time and imports BOTH layouts into fresh pods, asserting they are equivalent: identical 236 record subjects and identical 249 resolved edge triples across all four families (`clinical:hasEncounter` 181, `clinical:hasLabResult` 31, `clinical:indicationReference` 19, `coverage:relatedClaim` 18), with nonzero encounter resolution the real export cannot exercise, and the split import byte-deterministic across runs. The bundle is committed once, minified (`test-fixtures/synthea-grant908-bundle.json`); the 254-file split is generated at test time so the repo carries one artifact, not 254. This makes the bundle == split equivalence a committed invariant that catches any future per-batch or per-file resolution regression at full scale.

- **Relations trapped in literals are lifted into real edges at import** (graph-meaning slice M1). Two relation families were present in real pods but stranded in strings no graph query can follow, and one of them was being discarded outright. (1) `clinical:linkedConditionIds`, the literal Cascade Checkup packs related-condition UUIDs into, is now parsed and materialized as real `clinical:linkedCondition` edges. The parser accepts comma AND space delimiters: Checkup emits comma-separated lowercased UUIDs, while the clinical v1.10 deprecation comment describes them as space-separated (the comment is wrong; filed separately). Each UUID resolves against a pod-wide condition index built from subject IRIs (both the `urn:uuid:` and Checkup's `<#condition-{uuid}>` fragment forms) and `sourceRecordId` literals; an unresolvable UUID is counted and NOT written, and a self-link is never written. The deprecated source literal is retained this slice, so nothing is lost ahead of Checkup's own data migration. (2) A record's coded clinical reason (`reasonCode` on MedicationRequest, MedicationStatement, MedicationAdministration, and Procedure) was previously dropped by the converter entirely. It is now retained as a `clinical:indication` literal (one per record, joined, because `clinical:MedicationShape` caps it at `sh:maxCount 1`) AND matched against the condition records in scope to materialize `clinical:parsedIndicationReference` (new in clinical v1.12), a subproperty of `clinical:indicationReference` so one traversal over the superproperty returns both stated and parsed indications while the predicate itself carries the basis. Matching is code-first (exact coding-system + code identity, skipping unmappable systems such as ICD-9) with an exact normalized-name fallback; an edge is written only when EXACTLY ONE candidate matches, and ambiguous, unmatched, and already-stated cases are counted in the import report rather than guessed. A record that already states the same indication via `reasonReference` never gets a parsed restatement of it. Free-text `clinical:indication` / `clinical:reasonForUse` / `checkup:reasonForUse` literals arriving through the Turtle passthrough path are lifted by the same name fallback. **The lift runs once over the merged, reconciled result** (every input file plus the existing pod), not per file, because the condition a literal names is routinely in another file of the same import or already in the pod: an Apple Health export is one FHIR resource per file, so an in-batch-only match would find nothing. `convert()` gains a `deferLiteralLifting` flag for that caller; by default it resolves against its own batch and drops what does not match, so no placeholder can reach serialized output on the standalone path. The pass is idempotent (a re-import reports already-present edges as redundant instead of duplicating them) and deterministic (candidate sets are sorted before the unambiguity check). The new predicates are not in the Workbench edge-ranking allowlist, so the app cannot see them and the verdict path is untouched by construction. Verified: on a real provider export reached via Apple Health, which carries **0** `reasonReference` and would otherwise yield no indication edge at all, the import materializes **26** `parsedIndicationReference` edges (plus 9 ambiguous and 15 unmatched, all counted) and preserves 27 reason literals that were previously discarded; traversal reaches them in both directions (`--neighbors --edge clinical:parsedIndicationReference` returns the indicated conditions from a medication, and 16 medications/procedures back from one condition) and `--all --edges` projects all 26. Fresh Synthea specimen: every existing edge family unchanged (181 `hasEncounter`, 19 `indicationReference`, 31 `hasLabResult`, 18 `relatedClaim`), 9 previously-dropped reasons now retained as literals, 0 lifted (its 9 reason codes genuinely match none of its 17 condition codes, confirmed against the source bundle). `cascade validate` clean on all three specimens (20/20, 17/17, 11/11); both corpora byte-deterministic across runs (timestamps excepted); `pod query` with no flags byte-identical to before.

- **Record-to-encounter and medication/procedure-indication edges** (b/c). The FHIR converters carried the visit context (`resource.encounter`) and the clinical reason (`reasonReference`) as source data but dropped both: a fresh Synthea import materialized zero encounter or indication edges even though the bundle holds 168 top-level encounter references and 19 `reasonReference` links. Two new record-to-record edge families now flow through R1's end-of-batch reference-resolution machinery (emit a placeholder, then rewrite to the target's real minted subject at end of batch, or drop and count when the target is absent): (1) `clinical:hasEncounter` from `resource.encounter` on Observation (lab and vital), Procedure, Condition, DiagnosticReport, MedicationRequest, Immunization, and ImagingStudy, plus the nested `DocumentReference.context.encounter[]` array; (2) `clinical:indicationReference` from `reasonReference` on Procedure, MedicationRequest, and MedicationAdministration. Two shared helpers keep every site on the one placeholder path, so resolution, the drop-and-count policy, and the per-predicate import-summary tally all come for free, and the edges traverse through the graph query surface (`--neighbors`, `--all --edges`) unchanged. `reasonCode`/`indication` free-text mapping is untouched, so no indication is duplicated. Needs the clinical v1.11 domain widen (below) so an indication edge on a Procedure does not imply the Procedure is a medication. Verified: fresh Synthea specimen resolves 181/181 `hasEncounter` (168 top-level + 13 DocumentReference) and 19/19 `indicationReference`, zero dangling, zero leaked placeholders; `hasLabResult` (31) and `relatedClaim` (18) are unchanged; two imports produce byte-identical clinical containers.
- **C-CDA encounter extraction completeness and panel-to-visit edges** (c/d). Two defects, verified against a retained Epic export. (1) The Encounters-section extractor read `entry.encounter` (which the C-CDA parser always normalizes to an array) as a single object, so every field came back undefined and all encounters collapsed into one bare, content-hash-identical record. It now iterates the array and mints one populated `clinical:Encounter` each, with a display-name fallback (`@_displayName`, then a `translation`'s display name, then a plain-text `originalText`; a narrative `<reference>` `originalText` is a pointer, not a literal, and is skipped rather than misrecorded as a type). (2) The patient's real visit history lived nowhere in the output: the fully-defined `<encounter>` elements (dozens of references resolving to 20 distinct visits) sit nested inside the Results section's lab organizers, which no extractor read. The results extractor now collects each organizer's encounter(s), mints one `clinical:Encounter` per distinct visit (a shared `buildEncounterRecord`, deduped across the section), and links each lab panel to its visit with `clinical:hasEncounter`. `CCDA_FORWARD_EDGES` gains `clinical:hasEncounter` so the import-summary census counts the new family. Verified: fresh re-import of the retained export produces 20 populated encounter records (was 1 bare) and 55 resolving `hasEncounter` edges, `hasLabResult` (498) and the 55 lab-reports unchanged, `cascade validate` clean (14/14 files).
- **Graph-aware pod query surface**. A pod is a typed RDF graph, but `pod query --all` flattened it to per-type record buckets with every edge discarded. Two read-only, additive flags now expose the record-to-record edges the importer materializes (`clinical:hasLabResult`, `coverage:relatedClaim`, and any future edge, generically), built on the `n3.Store` already shipped (no new dependencies): (1) `pod query --neighbors <iri> [--hops N] [--edge <pred>...]` returns the typed neighborhood of a record as JSON, traversing stored forward edges in **both** directions (a lab result reaches its report via the inverse of `hasLabResult`, reported as `direction: "in"`); `--hops` defaults to 1 and caps at 3; `--edge` is repeatable and accepts a full IRI or a `prefix:local` CURIE; an unknown seed or bad flag is a clean error. (2) `pod query --all --edges` adds a top-level `edges` array of `{ subject, predicate, object }` restricted to record-to-record edges, alongside the existing flat buckets. An edge is defined generically (any triple whose subject and object are both record subjects), so no predicate is hardcoded and future reason/encounter edges flow through unchanged; `rdf:type`, code-system IRIs, and vocab terms fall out because their objects are not record subjects. Output is deterministic (stable ordering by predicate then subject/direction then neighbor IRI) and strictly additive: `pod query --all` **without** `--edges` is byte-identical to before (locked in by a test), and encrypted pods traverse through the same decrypt path. JSON contract documented in `docs/2026-07-16-graph-query-json-shapes.md`. This is the protocol-side prerequisite for graph-native retrieval in Workbench (seed-then-expand over typed edges). Verified: fresh Synthea specimen reports 49 edges (31 `hasLabResult` + 18 `relatedClaim`); a report's neighborhood is exactly its results at hop 1, a result reaches its report (in) and its siblings at hop 2; byte-deterministic across runs.
- **C-CDA lab panels are materialized as records with membership edges**. The C-CDA results section (`templateId 2.16.840.1.113883.10.20.22.2.3.1`) previously walked a BATTERY organizer as a mere wrapper: it emitted the member `health:LabResultRecord` observations and discarded the panel identity, so a real MyChart export with 55 lab panels imported 461 lab-results and zero lab-reports (no record-to-record edge on the C-CDA path at all). The converter now mints one `clinical:LaboratoryReport` per BATTERY organizer, with a `clinical:hasLabResult` edge to each of its member results, so C-CDA imports carry the same panel-to-result edge family the FHIR path does. Each edge object is a member's real minted subject computed in the same walk, so every edge resolves by construction; the import summary now tallies the C-CDA edges alongside the FHIR ones. The panel subject is content-hashed from patient + panel LOINC code + clinical date + the organizer's own id (root:extension), so re-importing the same document yields the same subject (an exact re-import dedupes rather than doubling the panels) and two imports produce byte-identical panel subjects. The organizer id is a first-class identity field because real Epic organizers routinely omit the organizer-level `<code>` (47 of 55 in the acceptance export), and keying on code + date alone would collapse distinct same-day panels and pool their members. Panel records carry `clinical:panelName`, the LOINC `clinical:loincCode` when the organizer code is LOINC, `clinical:documentDate` (the organizer's `effectiveTime`, falling back to the earliest member result date, then to the import timestamp only when the document carries no date at all), and the `ClinicalDocument` shape's required `importedAt` / `fhirResourceId` / `fhirResourceType` fields, so they validate. CLUSTER organizers in the results section are left as standalone member results (no panel), and standalone observations are untouched. Verified: fresh import of the retained MyChart export yields 55 lab-reports and 498 `hasLabResult` edges, all resolving with zero dangling or placeholder IRIs, `cascade validate` clean; a double import stays at 55 panels; the FHIR path is unchanged (Synthea specimen still 31/31 `hasLabResult` + 18/18 `relatedClaim`).

### Changed

- **BREAKING for genomics data: VCF import now derives `genomics:SequencingRun` identity from the file's content instead of its path** (backlog 3.7). The run IRI was minted by hashing `ImportContext.inputPath`, and every `genomics:Variant` and sample IRI derives from the run IRI, so the identity of an entire imported genome moved with the file. Importing the same VCF from a second location — after moving it, renaming it, copying it to another machine, or re-downloading it to a different directory — minted a second `SequencingRun` and a duplicate set of Variants rather than reconciling with the records already in the pod. Measured on identical bytes at two paths: runs `b3f1b1b5-…` and `5726393c-…`, 1725 variants each, nothing in common. The run IRI is now `deterministicUuid("SequencingRun|sha256:<digest>")` where the digest is a SHA-256 over the DECOMPRESSED VCF content, so the same logical VCF yields the same identity whether it is stored plain, gzipped, or re-gzipped at a different compression level (gzip output is not byte-stable across compressors, so hashing the raw file bytes would have reproduced a subtler version of the same defect). The header coordinates the old key also carried (`fileDate`, `source`, `reference`) are read out of the content and so are already determined by the digest; they were dropped rather than restated. The input path is still recorded as `sourceId` on the import-manifest entry, which is where "where did these bytes come from" belongs — provenance, not identity.

  **What this means if you already hold imported VCF data:** every `genomics:SequencingRun`, `genomics:Variant`, and sample IRI minted by an earlier release was derived under the path-based scheme and will NOT match what this release mints for the same file. Re-importing a VCF into an existing pod will therefore add a fresh set of records alongside the old ones instead of reconciling with them. There is no automatic migration. If you are carrying genomics data forward, re-import into a clean pod, or map the old run IRI to the new one yourself and rewrite the derived IRIs. This is deliberately being done now, while the change is cheap: it only gets more expensive the longer path-derived genomics IRIs stay in circulation. Non-genomics importers are unaffected — no other format derived identity from the input path.

  The conformance oracle (`conformance` repo, `fixtures/genomics/vcf/sample-clinvar.expected.ttl`) was regenerated against the new scheme and verified to be isomorphic to the old one modulo IRI renaming: 21,891 triples both sides, 1725 Variants, identical predicate and literal multisets, and a unique structural bijection over all 1726 minted IRIs under which the old graph replays exactly onto the new one. The two `tests/vcf-conformance.test.ts` cases that had been quarantined out of CI because the oracle only reproduced at one absolute path are un-quarantined, and `tests/vcf-content-addressed-identity.test.ts` pins the invariant directly.

- **`pod export` refuses an encrypted pod unless `--allow-encrypted`, and stamps the export when you use it** (backlog 3.67; decision D-CLI-2). This command copies bytes rather than parsing them, so it was the one read verb that "worked" on an encrypted pod: it produced a zip or directory full of ciphertext, reported success, and was indistinguishable from a healthy export until somebody opened it. Exporting a sealed pod is now an explicit choice. Without the flag the command exits **1** (not 2 — nothing failed to be read; the user has a decision to make) and says what the alternatives are; the refusal does not need the key, so it is the same answer in every passphrase state. With `--allow-encrypted` the export proceeds AND carries an `ENCRYPTED-EXPORT-README.md` explaining that the files are ciphertext rather than damaged, where the wrapped key lives, and what is needed to read them — so a clinician handed the archive gets an explanation instead of a brick. Plaintext pods export exactly as before, with no flag and no notice.

- **`pod info` resolves the passphrase the same way every other read verb does.** It previously read `CASCADE_POD_PASSPHRASE` only, and only for the owner's name. It now uses the shared resolution (env var, then a hidden prompt when interactive), so an interactive `pod info` on an encrypted pod asks for the passphrase instead of silently degrading. Scripted callers that relied on the env-only path are unaffected when the variable is set; those that relied on getting exit 0 and an empty summary without it will now get exit 2 and a stated reason, which is the point of the fix above.

- **Embedded clinical shapes synced to spec clinical v1.12** (spec tag `vocab/clinical-v1.12`). Adds `clinical:parsedIndicationReference`, an `rdfs:subPropertyOf clinical:indicationReference` marking an indication edge the importer DERIVED by parsing a coded or free-text reason on a record and matching it to a condition, as distinct from `clinical:indicationReference` proper, which restates a `reasonReference` the source explicitly carried. Modeled as a subproperty so traversal over the superproperty returns both families while the predicate remains the machine-readable basis: no reification and no RDF-star, so the edge stays a plain triple every existing consumer already reads. It deliberately carries no confidence score, because this is a deterministic parse of what the record says and not structural or temporal inference (which stays out of the pod and is computed at query time). `ParsedIndicationReferenceEdgeShape` is warning-only and `sh:nodeKind`-only, with no `sh:class`, matching `IndicationReferenceEdgeShape` and the v1.11 per-file-validation rationale. `VOCAB_VERSIONS` now reads `clinical=1.12`. Verified: `cascade validate` clean on pods carrying the new edges (20/20, 17/17, 11/11 files).

- **Embedded clinical shapes synced to spec clinical v1.11** (spec tag `vocab/clinical-v1.11`; two edge-vocabulary refinements the R3 importer needs). (1) `clinical:indicationReference` dropped its restrictive `rdfs:domain clinical:Medication` in favor of the broad-domain comment + SHACL pattern the other cross-class edges use: FHIR carries `reasonReference` on Procedure, MedicationRequest, MedicationAdministration, Encounter, and other event resources, not only medications (Procedure is 17 of the 19 links in the Synthea specimen), and the old domain would have made an OWL reasoner infer those Procedures are medications. (2) `HasEncounterEdgeShape` and `LinkedConditionEdgeShape` dropped their `sh:class` constraints (`clinical:Encounter` / `clinical:Condition`), keeping `sh:nodeKind sh:IRI`. Cascade stores records in per-type files and the reference validator checks each file independently, so an edge whose target lives in a sibling file (a lab result pointing at an encounter) can never satisfy `sh:class`: it produced a `sh:Warning` on every well-formed, fully-resolving edge (all 181 `hasEncounter` edges of the specimen) and never caught a real error. Target class stays guaranteed at import time (an edge is written only when it resolves to a real record) and can be re-checked by a future pod-wide validator; this aligns both shapes with the always-open `IndicationReferenceEdgeShape`. Shapes-only sync (no `clinical.shapes.ttl` change was needed for the domain widen, which the edge shape never encoded). `VOCAB_VERSIONS` now reads `clinical=1.11`. Verified: `cascade validate` is clean (20/20 files, 0 violations, 0 warnings) on a fresh Synthea pod carrying the R3 edges.
- **Embedded clinical shapes synced to spec clinical v1.10** (graph edge vocabulary; spec PR the-cascade-protocol/spec#9, tag `vocab/clinical-v1.10`). `scripts/sync-shapes-from-spec.sh` refreshed `src/shapes/clinical.ttl` and `src/shapes/clinical.shapes.ttl` so `cascade validate` knows the new record-to-record edge terms: `clinical:hasEncounter` (record to encounter), `clinical:indicationReference` (medication to condition/observation), and `clinical:linkedCondition` (condition to condition, replacing the now `owl:deprecated` `clinical:linkedConditionIds` literal). The `clinical:hasLabResult` range was also corrected from `clinical:LabResult` to `health:LabResultRecord` to match what both importer paths actually type panel members. The three new edges get open-world `sh:targetSubjectsOf` PropertyShapes (IRI nodeKind, `sh:class` where the range is committed, `sh:Warning`, no `minCount`), so validation is strictly additive: a fresh Synthea import still validates clean, and pods carrying none of these predicates are unaffected. Shapes-only sync; no importer or CLI behavior change here (the importer materializes these edges in a later slice). `VOCAB_VERSIONS` now reads `clinical=1.10`.

### Fixed

- **`pod info` no longer prints a summary of nothing over an encrypted pod** (backlog 3.20). Every data file was parsed as PLAINTEXT, and the DEK was resolved for the owner's name only — non-interactively, best-effort, and silently abandoned on a wrong or absent key. On an encrypted pod that meant every parse failed, every failure was swallowed by a `continue`, and the command printed "This pod has no data files yet" at exit 0; in `--json` it produced `"patient": {}` with empty `clinical` / `wellness` arrays and an extraction status of all zeros, which is byte-for-byte what a genuinely empty pod produces. `analysis/review-queue.json` was read with a plain `fs.readFile` even though it is inside the encrypted set, so the pending-review count was a silent zero for the same reason. Every read now goes through the pod read layer. A pod that cannot be opened exits **2** with a message naming the state ("this pod is encrypted and the passphrase was not provided / did not open it") and, under `--json`, an envelope carrying `encrypted: true`, `readable: false` and a machine-readable `reason`; a pod that opens but holds a file that will not read exits **2** naming the files. The successful `--json` payload now states `encrypted` and `readable: true` positively, so a consumer can branch on the state instead of inferring health from the absence of an error.

- **MCP `cascade_pod_read` and `cascade_pod_query` no longer hand an agent an empty pod** (backlog 3.65). Both handlers called `parseDataFile(filePath)` with no DEK, and `pod_read` read the patient profile the same way, so on an encrypted pod they returned a SUCCESSFUL result with `totalRecords: 0`, `recordCounts: {}` and `"name": "Unknown"`. An agent restates whatever it is handed, so that was not a soft failure but a confident false statement about someone's health record. Each handler now opens the pod once through the read layer and returns a TYPED error instead of a hollow success: `code: "pod-unreadable"` with `reason: "passphrase-missing" | "passphrase-incorrect"` when the pod will not open, and `code: "pod-files-unreadable"` with the offending file list when it opens and a file inside it does not. No successful payload is emitted in either case, and the audit entry is no longer written for a read that did not happen.

- **`pod erase` no longer says "not found" about a file it could not open** (backlog 3.66). The search loop did `catch { continue }` past any file it failed to read, so on an encrypted pod read without the key EVERY bucket was skipped and the command reported "Record not found in any bucket file" — about a record sitting right there — at exit 1. For an erasure verb the direction of the error is the whole point. Read failures are now collected instead of stepped over: if the record is not found AND any file was unreadable, the command exits **2** with a message naming those files and stating explicitly that the record was not found in the files that COULD be read, which is not the same as the record not existing, and that nothing was erased. If the record IS found while other files were unreadable, the erasure proceeds and a warning names the files that were not searched, so the claim "this record is gone from the pod" is bounded by what was actually looked at. The scan no longer stops at the first match (only the first match is still erased), so whether the user is warned does not depend on where an unreadable file happens to sort. A pod that will not open exits 2 rather than 1.

- **`pod extract` reads `clinical/documents.ttl` through the pod key** (discovered while sweeping 3.20; same defect, previously unfiled). The narrative-block scan used a plaintext `parseTurtleFile`, so on an encrypted pod it parsed ciphertext and exited 1 with "Failed to parse clinical/documents.ttl". The read now goes through the read layer; a pod that will not open, or a documents file that will not read, exits **2** with a message saying what it is NOT. The extraction WRITE path (`clinical/ai-extracted.ttl`, the review queue, the discard log, the index append) is still plaintext-only, so the command now refuses the mutating path on an encrypted pod with an explanation rather than dropping readable files into a sealed one; `--dry-run` is read-only and works normally.

- **`pod query` no longer reports a pod it could not read as a pod with nothing in it.** Every read in the command goes through `parseDataFile`, which answers a decrypt failure or a parse failure with `{ records: [], error }`. That error travelled in a per-bucket `error` field on an otherwise successful payload, so on an encrypted pod the command exited **0** with all fifteen registered buckets present, every `count` zero, and the reason buried where no consumer looked. Measured on a throwaway encrypted pod holding 236 records: with the passphrase, exit 0 and the real counts; with the manifest removed so the command did not know to ask for a key, exit **0** and 15 buckets of zero; with one sealed file left in the clear, exit **0** and that bucket zero. Any caller reading `count` — which is what a record count is — saw an empty pod and said so. This is the same lesson `pod conflicts` learned in the previous release, applied to records: a read failure now exits **2** with a message that names the files and ends by saying what it is NOT. Two failures are weighed differently, because failing on anything would be its own outage: a file that will not DECRYPT is a key problem and is always fatal, while a file that opens and is not valid Turtle is fatal only for a registered record file (`clinical/…`, `wellness/…`) and is a loud warning for the unregistered `.ttl` files a pod also holds (notes, investigations, reports, analysis bundles) — one stray file must not blank a whole record list. The `--all --edges` projection and `--neighbors` traversal take the same guard, so "this record has no edges" and "no record found with that IRI" are no longer answers given over files that never opened. Exit 2 also replaces exit 1 when the pod itself cannot be opened (no passphrase, wrong passphrase), so a caller can tell a read failure from a usage error. Covered by 8 new regression tests on a real encrypted pod.

- **A re-import no longer appends duplicate stated-edge triples, and says honestly that nothing was new** (3.53, 3.52). Re-importing the same data is the normal update path, and it grew the pod on every run. A record-to-record edge reaches the reconciler in two spellings: already RESOLVED, as the pod holds it, and still a PLACEHOLDER, as a fresh conversion emits it (reference resolution is deferred to once per import invocation, R5). Full quad-identity dedup cannot see they are one statement, so both survived, the import's resolution pass rewrote the placeholder to the very same target, and the subject ended up stating the edge twice. Measured before the fix on this repo's fixtures: one bundle's 11 stated edges became 17 statements and Turtle grew 19,282 to 20,807 bytes (+7.9%), with `cascade:reconciliationStatus` growing without bound (0, 5, 10 across three imports) because the reconciler re-derives it while the previous run's copy arrives as an ordinary parsed property. The reconciler now keys each passthrough edge on where its object RESOLVES TO rather than on the object's current spelling, keeping one quad per `(subject, predicate, resolved-target)` and preferring the already-resolved copy; it does NOT drop placeholders merely because a predicate already carries a resolved value, so a lab report that genuinely gains a third result keeps it. Bookkeeping the reconciler re-derives is no longer carried in from the pod, and merge lineage (`cascade:mergedFrom`, `prov:wasDerivedFrom`) is de-duplicated at emission rather than dropped, so a run in which nothing merged still preserves it. Two reporting defects on the same path are fixed with it: a 100%-duplicate import reported every record as freshly imported and `0` duplicates, and its `edgeResolution` deltas fell toward zero in a way that read as edge loss. The report now carries `recordsNew` / `recordsAlreadyPresent`, the reconciler summary carries `duplicateSubjectsDropped`, and `edgeResolution.totalInPod` (per-predicate too) gives the stable "edges the pod holds" number a linked-record count needs, while `resolved`/`unresolved` keep their per-run-delta meaning. A prefixes-only `settings/pending-conflicts.ttl` is no longer created when there are no conflicts (an existing file is still rewritten, so resolving the last conflict still clears it). And `--report <file>` is now written under `--dry-run`, where a machine-readable preflight matters most; it was silently ignored before, with no file and no warning. `--dry-run` still writes nothing to the pod. Verified: importing the multi-file fixture three times leaves the pod byte-identical after every import (16,781 bytes each; previously 17,360 then 17,843, with 8 distinct edges stated 12 times), the single-bundle path is byte-identical from the second import onward and never duplicates an edge at any step, single imports are byte-identical to before this change apart from the wall-clock `importedAt` and the no-longer-created empty conflicts file, and the reconciler is a fixed point on its own output. Full suite 1171 passed / 21 skipped.
- **`cascade pod decrypt` no longer destroys every pod resource outside four directories** (and 4.25). `enumerateResources` walked an allowlist of `clinical/`, `wellness/`, `profile/`, `settings/` plus `index.ttl` and two named files, and BOTH `pod encrypt` and `pod decrypt` used it, so both agreed on the same wrong answer. DEK-aware writers grew up outside that list: `src/lib/annotations.ts` seals `<pod>/annotations/*.ttl`, and the Cascade Workbench's migrate-on-open seals essentially the whole pod, so `notes/`, `analysis/`, `literature/`, `reports/`, `sources/` and `investigations/` are ciphertext on any pod the app has opened. `pod decrypt` enumerated none of them, left them as ciphertext, then deleted `settings/encryption.json`, the only wrapped copy of the DEK: the data was unrecoverable from that moment, the command exited 0, and the "Resources decrypted: N" count came from the same allowlist, so the count itself was the lie. A new module, `src/lib/pod-resources.ts`, is now the single authority for what a pod resource is, and the rule is inverted: it WALKS the pod and excludes only the three by-design plaintext paths (`README.md`, `settings/encryption.json`, and `provenance/egress-log.jsonl`, which is append-only and cross-process). A new container is covered the day it is created rather than when someone remembers to extend a list. Both directions are now byte-level (`readResourceBytes`/`writeResourceBytes`), so a retained source PDF round-trips exactly instead of being mangled through a UTF-8 string; both are idempotent (a file already in the target state is left untouched and counted separately, so a re-run after an interruption finishes the job rather than double-sealing, which would be unrecoverable); and each rewrite is a temp-file-plus-rename, so an interruption leaves every file fully in one state or the other. `pod decrypt` classifies the whole pod BEFORE writing anything: a file that does not open with the pod key aborts the run with nothing written and the manifest kept, so the pod stays recoverable, unless the new `--force` is passed (which decrypts the rest, leaves those files untouched, and warns on stderr naming them). Each decrypted file is read back and confirmed plaintext on disk, and only then is the manifest removed. Reported counts now say what actually happened: decrypted, already plaintext, plaintext by design, left unchanged. Verified end to end against the built CLI with a canary sealed into `annotations/` and `notes/`: pre-fix it stayed ciphertext with the key gone; now it comes back readable and the reported count covers it. Regression tests in `tests/pod-encrypt-decrypt-roundtrip.test.ts` fail against the pre-fix command.

- **The conflict store is DEK-aware, and a read failure is no longer reported as zero conflicts**. `settings/` is inside the encrypted set, so on an encrypted pod both `settings/pending-conflicts.ttl` and `settings/user-resolutions.ttl` are ciphertext, and `src/lib/user-resolutions.ts` had no DEK awareness in either direction. Reading, the Turtle parser failed on ciphertext and both loaders swallowed it behind a bare catch ("soft failure, return empty"), so `cascade pod conflicts <encrypted-pod>` printed "No unresolved conflicts" and exited 0 with the conflict sitting right there, indistinguishable from a genuinely clean pod, and recorded user resolution decisions were silently forgotten the same way. Writing, `writePendingConflicts` did a plain `writeFile(..., 'utf-8')` and `pod import` calls it unconditionally whenever reconciliation runs, so every import into a sealed pod dropped a plaintext file into it holding record types, source EHR names, normalized drug names and candidate record IRIs. Every read and write now takes the pod DEK, routed through the existing `readResource`/`writeResource` chokepoint. An ABSENT file is still a legitimate empty list, and is the only absence tolerated; anything else (unreadable, undecryptable, unparseable) throws the new `ConflictStoreError`, so a caller can always tell "no conflicts" from "could not read the conflicts". `pod conflicts` and `pod resolve` resolve the key through a new `resolvePodDekIfEncrypted` helper and exit **2** on a read failure, distinct from the existing 0 (none) and 1 (conflicts present); `pod import` passes the DEK it had already resolved. Verified end to end against the built CLI: one synthetic `cascade:PendingConflict` reported 1 before encryption, the file became ciphertext after `pod encrypt`, and it still reports 1 (pre-fix: 0, exit 0). Regression tests in `tests/user-resolutions-encrypted.test.ts` fail against the pre-fix module.

- **Cross-file reference edges resolve on the Apple Health import path** (found during M1 acceptance, PRE-EXISTING on main, not an M1 regression). Reference resolution (`resolveReferenceEdges`) ran once per CONVERSION BATCH, and an Apple Health export is one FHIR resource per file (1,267 files in the real specimen), so a reference's target was almost never in the same batch and EVERY reference edge dropped: the real export imported 1601 of 1601 edges as unresolved (732 `clinical:hasLabResult`, 869 `clinical:hasEncounter`, 0 resolved). Synthea hid the defect because it is a single 254-entry bundle where everything resolves in-batch. Resolution now runs once per IMPORT INVOCATION. The FHIR converter defers via a new `convert()` flag `deferReferenceResolution` (a sibling of M1's `deferLiteralLifting`), leaving each edge as its placeholder in the per-file output; `pod import` then resolves every placeholder in one pass over the merged, reconciled quad set, rewriting it to the referenced record's real minted subject or dropping-and-counting it when the target is genuinely absent. The R1 resolve-or-drop semantics are unchanged (an edge is written only when it resolves, unresolved ones are counted in the import report, never dangling). The end-of-import index is rebuilt from the merged records' persisted `sourceRecordId` (the join the 2026-07-16 audit measured at 100%) rather than an accumulated conversion-time list, which is what keeps it reconciliation-safe: a record the reconciler merged away is not in the merged quads, so its id is absent from the index and a reference to it drops-and-counts instead of resolving to a discarded subject. **Scope is same-invocation resolution only.** Resolving a new reference against a record already in the pod from a PRIOR import is a separate follow-up, because it pairs with the `--reconcile-existing` re-import semantics; this slice does not change it. The C-CDA path is untouched (a C-CDA document is a self-contained bundle, so it keeps resolving in-batch and `deferReferenceResolution` is never set for it), and the standalone `cascade convert` path is untouched (the flag defaults false, so it resolves against its own batch and no placeholder can ever reach serialized output). Verified: on the real Apple Health export, `clinical:hasLabResult` goes from 0/732 resolved to **648 of 732 resolved** (the 84 residual references target lab observations the reconciled export does not carry), and `clinical:hasEncounter` stays 0 resolved because the export contains no `Encounter` resource at all (the 799 references are honest residue against a resource type the export genuinely lacks, down from 869 because reconciliation collapsed duplicate carriers); M1's parsed-indication lift is unchanged at 26; the pod validates clean (17/17 files) with zero placeholder leaks, and `pod query --neighbors` traverses a newly resolved lab edge in both directions. Fresh Synthea specimen: byte-identical to pre-fix output (249/249 edges resolve exactly as before across all four families, `cascade validate` 20/20, `pod query` with no flags byte-identical), because a single-bundle import resolves the whole batch in one merged scope either way. Retained MyChart C-CDA re-import: byte-identical (the C-CDA path is proven untouched). A synthetic multi-file fixture reproducing the Apple Health layout resolves all 8 of its cross-file edges (2 `hasLabResult`, 4 `hasEncounter`, 1 `indicationReference`, 1 `relatedClaim`) and drops-and-counts the 1 reference whose target is absent; both corpora are byte-deterministic across double runs.

- **Record-to-record edges survive reconciliation** (and the bundled lineage decision 3.13). R1 resolves every edge (`clinical:hasLabResult`, `coverage:relatedClaim`, `clinical:hasEncounter`, `clinical:indicationReference`) at conversion time, before reconciliation. The reconciler then merges near-duplicate records and discards the losing subjects, but it never rewrote other records' edge objects, so an edge pointing at a merged-away duplicate re-dangled on exactly the paths real users hit monthly: overlapping exports and `--reconcile-existing` re-imports (fresh single imports and exact re-imports were unaffected, which is why R1's clean-import acceptance held). The reconciler now builds one discarded-subject to canonical-subject map over every merge decision in the run (in-batch merges and merges against existing pod content), then during serialization redirects any edge object that points at a discarded subject to its surviving canonical subject, across both reconciled groups and passthrough quads (the edge-holding `clinical:LaboratoryReport` / `coverage:BenefitStatement` records ride the passthrough path). The redirect follows the map transitively (A to B to C lands on C) with a cycle guard, and the import summary reports the count of repaired edges. **Lineage is dangling by design:** `cascade:mergedFrom`, `prov:wasDerivedFrom`, `cascade:discardedRecords`, and `workbench:erasedRecord` are excluded from the rewrite (redirecting `mergedFrom` to the survivor would self-loop and destroy the provenance it exists to record); these predicates reference historical, non-materialized subjects, and a graph-query surface should treat them as such. Verified: a controlled two-bundle re-import where a referenced lab near-duplicate-merges now redirects the report's `hasLabResult` to the surviving lab on disk (it dangled before); the Synthea specimen is unchanged on a fresh import (249/249 edges resolve across four families, `cascade validate` 20/20) and stays fully resolving after a reconciled overlapping re-import (69 records merged, zero re-dangled edge-family objects; the merge lineage dangles as designed); the reconciled re-import path is byte-deterministic (timestamps excepted). Full suite 1050 passed / 21 skipped.
- **Re-import no longer duplicates `clinical:importedAt` (SHACL failure on the monthly update path)**. Re-importing a portal export is the normal monthly update, but the passthrough record types (`clinical:ClinicalDocument`, `clinical:LaboratoryReport`) are carried through reconciliation verbatim and deduplicated only by full quad identity. `clinical:importedAt` is stamped `new Date().toISOString()` on every conversion run and is deliberately excluded from the record's identity hash, so a re-import lands a second timestamp on the same content-stable subject, and both shapes require exactly one (`cascade validate`: "Clinical document must have exactly one importedAt timestamp"). The reconciler now collapses single-cardinality passthrough predicates to one value per subject, keeping the earliest (the record's original import time, which stays stable across any number of later re-imports so the field does not churn). Scope is deliberately `importedAt`-only; the sibling predicates that can hit the same trap (`prov:generatedAtTime`, `clinical:sourceEHR` on a cross-source re-import, the genomics `GeneticTest` timestamp) are catalogued with dispositions in `docs/2026-07-16-single-cardinality-passthrough-survey.md`. Reconciled record types are unaffected (they already collapse to one canonical), and single imports are unaffected (no reconciliation runs). Verified: a double import of the Synthea specimen left all 37 document-family subjects with two `importedAt` values and failed validation before; now each carries exactly one, `cascade validate` is clean, and the kept timestamp is byte-stable across a third and fourth re-import. Full suite 1044 passed / 21 skipped.
- **Cross-record reference edges now resolve on import**. The FHIR converters wrote `clinical:hasLabResult` (DiagnosticReport to Observation) and `coverage:relatedClaim` (ExplanationOfBenefit to Claim) as `urn:uuid:<last-path-segment>`, which dangled 100% of the time: referenced records get content-hashed or deterministically minted subjects (never the raw id), and `urn:uuid:` fullUrl references got a second `urn:uuid:` prepended. Both edge families now go through one path. Converters emit each edge as a placeholder carrying the raw reference; at the end of a conversion batch, when every record's minted subject is known, the reference is rewritten to that real subject IRI. An edge is written only when it resolves; a reference whose target is absent from the batch is dropped and counted, and the import summary reports the tally (total plus per-predicate). Reference normalization handles `Observation/<id>`, `urn:uuid:<id>` (no double prefix), absolute URLs, and `/_history/` suffixes. Subject minting is unchanged. Verified: fresh Synthea specimen census shows 31/31 `hasLabResult` and 18/18 `relatedClaim` resolving as real subject IRIs with zero dangling or placeholder IRIs anywhere (was 0/49); two imports of the specimen produce byte-identical clinical containers (timestamps excepted); full suite green.
- **Type index is valid Turtle after a claims import**. When `cascade pod import` appended a `solid:TypeRegistration` block, it self-healed only the `fhir:` prefix, so registering a coverage class (Claim / ExplanationOfBenefit) wrote `coverage:...` into a file with no `@prefix coverage:` declaration. The result was an unparseable `settings/publicTypeIndex.ttl` (`Undefined prefix "coverage:"`) on every fresh pod that touched claims data, which broke any strict-Turtle consumer (validators, other Cascade apps, the coming graph-query surface). The self-heal now declares any Cascade prefix the appended block uses and the file lacks, and `pod init` seeds the index templates with `coverage:` (public) and `fhir:` (private) so new pods start complete. Verified: fresh Synthea import's `publicTypeIndex.ttl` parses under n3 strict mode (it failed on line 46 before).

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

[0.14.0]: https://github.com/the-cascade-protocol/cascade-cli/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/the-cascade-protocol/cascade-cli/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/the-cascade-protocol/cascade-cli/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/the-cascade-protocol/cascade-cli/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/the-cascade-protocol/cascade-cli/compare/v0.5.10...v0.10.0
[0.4.0]: https://github.com/the-cascade-protocol/cli/compare/v0.3.6...v0.4.0
[0.3.6]: https://github.com/the-cascade-protocol/cli/releases/tag/v0.3.6
