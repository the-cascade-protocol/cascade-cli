# Survey: single-cardinality passthrough predicates and re-import duplication

**Date:** 2026-07-16
**Context:** root backlog 1.5, symptom 3. Companion to the `clinical:importedAt` fix in `src/lib/reconciler.ts` (`collapseSingleCardinalityPassthrough`).

## The mechanism

Re-importing a portal export is the normal monthly update path. `cascade pod import --reconcile-existing` loads the existing pod as an implicit input and reconciles it against the new import.

The reconciler splits records two ways:

- **Reconciled types** (the `KNOWN_TYPES` allowlist: `clinical:Medication`, `health:ConditionRecord`, `health:LabResultRecord`, ...) are matched, grouped, and **collapsed to a single canonical record**. Any single-cardinality property therefore ends up with one value (the winner's). These types are immune to the bug below.
- **Passthrough subjects** (everything else: `clinical:ClinicalDocument`, `clinical:LaboratoryReport`, `clinical:Encounter`, `genomics:GeneticTest`, ...) are carried through **verbatim**, deduplicated only by *full quad identity* (`subject | predicate | object`). Two quads collapse only when their object is byte-identical.

The trap: a single-cardinality predicate whose **object legitimately changes between import runs** is never collapsed by quad-identity dedup, because the objects differ. The subject is content-hash-stable (the same document mints the same IRI every run), so the re-import lands a *second* value on the *same* subject. If a SHACL shape constrains that predicate to `sh:maxCount 1`, `cascade validate` then fails.

The flagship instance is `clinical:importedAt`: it is stamped `new Date().toISOString()` at conversion time and is deliberately excluded from the identity hash (so re-imports dedupe the record itself). Every monthly re-import adds another timestamp, and both `clinical:ClinicalDocument` and `clinical:LaboratoryReport` require exactly one. Verified on the Synthea specimen: a double import left all 37 document-family subjects (13 documents + 24 lab-reports) with two `importedAt` values and `cascade validate` failing.

## The fix (this PR)

`collapseSingleCardinalityPassthrough` collapses each `(subject, predicate)` in the predicate set `SINGLE_CARDINALITY_PASSTHROUGH_PREDICATES` to a single object per subject, choosing the lexicographically smallest value. For the ISO-8601 UTC timestamps this targets, that is the **earliest** time, i.e. when the record first entered the pod, which stays stable across any number of later re-imports (deterministic, no churn). The set currently contains **only `clinical:importedAt`**, on purpose: it is the only predicate that (a) varies per run and (b) is `sh:maxCount 1` on the common same-source re-import path, so it is the only one that actually fails validation today.

## Sibling catalogue

Each row is a single-cardinality (`sh:maxCount 1`) property that can appear on a passthrough subject, classified by whether its value varies and whether that variance breaks validation. "Same-source re-import" is the monthly-update path; "cross-source" means importing the *same* document from a second `--source-system`.

| Predicate | Where constrained | Value varies by | Duplicates on same-source re-import? | Fails validate? | Disposition |
|---|---|---|---|---|---|
| `clinical:importedAt` | `ClinicalDocumentShape`, `LaboratoryReportShape` (`sh:maxCount 1`) | **import run** (per-run timestamp) | **Yes** | **Yes** | **Fixed in this PR** (collapse to earliest) |
| `prov:generatedAtTime` (clinical documents) | *unconstrained* on the clinical path (only constrained on `workbench` notes and `genomics:GeneticTest`) | import run (C-CDA narrative, `narrative.ts`) | **Yes** (verified: 1 subject duplicated on the C-CDA double import) | No (no `sh:maxCount` on clinical docs) | **Latent, benign.** Accumulates redundant timestamps but does not fail validation. Fold into the set only if a `sh:maxCount 1` is ever added to the clinical shape, or generalize the collapse (see below). |
| `prov:generatedAtTime` (`genomics:GeneticTest`) | `genomics.shapes.ttl` (`sh:maxCount 1`) | import run | Would duplicate if a VCF is re-imported through `--reconcile-existing` (GeneticTest is a passthrough type) | **Would fail** | **Latent, would-fail.** Not exercised today (no genomics re-import regression in CI). Add `prov:generatedAtTime` to the set (or generalize) when genomics gains a re-import path. |
| `clinical:sourceEHR` | `ClinicalDocumentShape` (`sh:minCount 1 sh:maxCount 1`) | **source** (per `--source-system` / host), not per run | **No** (verified: 7 subjects, 0 duplicated on same-source re-import; identical value dedupes) | Only on cross-source re-import of the same document | **Latent, cross-source only.** Rare (a document re-fetched from a second portal label). Collapsing to one value would silently pick a winner and hide the multi-source provenance, so this wants a deliberate decision, not the timestamp treatment. |
| `clinical:sourceBundleId` | `ClinicalDocumentShape` (`sh:maxCount 1`, optional) | source (iOS bundle id) | No (same-source identical) | Cross-source only | Same as `sourceEHR`. |
| `clinical:documentDate` and other event dates (`performedDate`, `effectiveDate`, ...) | various (`sh:maxCount 1`) | **stable** (derived from clinical content; same value every run) | No | No | Not at risk. One narrow exception: `documentDate` falls back to `importedAt` when a document carries no date at all (`sections/labs.ts`), making it per-run in that degenerate case; not observed in the specimens. |

## Recommendation

- **Ship the importedAt-only collapse now** (this PR). It fixes the only predicate that fails validation on the routine monthly re-import path, with the smallest, most-obviously-correct change.
- **Two follow-ups worth filing** (kept out of this PR to hold scope):
  1. `prov:generatedAtTime` on `genomics:GeneticTest` will fail validation once genomics has a re-import path. Add it to `SINGLE_CARDINALITY_PASSTHROUGH_PREDICATES` (earliest-wins is the right semantics for a generated-at timestamp) when that path lands, and add a genomics double-import regression.
  2. `clinical:sourceEHR` / `clinical:sourceBundleId` duplicate only on cross-source re-import of the *same* document. The right fix is a provenance decision (keep the first-seen source? record all sources as a distinct multi-source annotation?), not a blind collapse. Defer until a cross-source re-import scenario is real.
- **If a third per-run predicate appears**, consider generalizing: instead of an explicit predicate list, collapse any passthrough `(subject, predicate)` that (a) carries a `sh:maxCount 1` in the loaded shapes and (b) has more than one value after quad-identity dedup, keeping the earliest for `xsd:dateTime` and flagging non-timestamp collisions for review. That is a larger change with its own correctness surface, so the explicit list is preferred until the list grows past two or three entries.
