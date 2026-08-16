# Pathology corpus

A regression corpus of real-world health-data import pathologies, and the
end-to-end harness that runs each one through the whole pipeline and records
what actually happens.

Every byte of every fixture is synthetic. The people, organizations, endpoints,
medical record numbers, dates and values are invented. What is NOT invented is
the SHAPE: each fixture reproduces one named phenomenon that appears in real
exports, so that the import and reconciliation paths can be worked on without a
real chart in the room.

The vendor-structure reference used while authoring (how the major EHRs lay out
a C-CDA: which templateIds appear, where ids and narrative references sit) is
the publicly published sample-document corpora and the HL7 C-CDA R2.1
implementation guide. No document from any corpus is vendored here; every
fixture is an independently authored synthetic equivalent.

## How to run it

```sh
npm run build          # the harness spawns dist/index.js
npx vitest run tests/pathology-corpus.test.ts
```

The harness lives in `tests/pathology-corpus.test.ts`; the known-defect ledger
it gates on lives in `tests/pathology-known-outcomes.ts`; the reconciliation
scorecard baseline lives in `tests/pathology-reconciliation-baseline.json`.

## Scenarios

| ID | Fixture(s) | Pathology |
|----|-----------|-----------|
| P01 | `p01-dual-label-fhir.json`, `p01-dual-label-ccda.xml` | **Dual-label split.** One health system exports FHIR (which states its endpoint domain, and on one resource an organization name) and a C-CDA (which states the custodian organization name). One system, two rows on the pod's source axis. |
| P02 | `p02-duplicate-source-id-ccda.xml` | **Duplicate source-id collision.** A single root-only `<id>` reused across three distinct lab observations, the shape the public HL7 CCD sample distributes. HL7 II says a root alone may be the whole identifier, so all three mint one IRI. |
| P03 | `p03-narrative-names-ccda.xml` | **Narrative-only test names, one dangling.** Names live in the section narrative and are referenced from the entry. Three references resolve, one points at an element the narrative does not contain, and one observation is named nowhere at all. |
| P04 | `p04-date-precision-ccda.xml` | **Date-precision variety.** Day precision, second precision with a zone offset, and a month-precision value that has no honest `xsd:date` or `xsd:dateTime` and must not be emitted. Carries the corpus's one procedure. |
| P05 | `p05-interpretation-categories-fhir.json` | **Interpretation codes across the HL7 set, and multi-category labs.** H, S, POS, a code outside the accepted set, and an observation with no interpretation at all; plus observations carrying two `category` entries. |
| P06 | `p06-indication-absence-fhir.json` | **Indication absence.** One MedicationRequest with `reasonReference`, one with a `reasonCode` that resolves, one with a `reasonCode` that does not, and two with neither. "The source never said" and "the source said and we could not match it" must not collapse. |
| P07 | `p07a-crosssource-labs-alpha.json`, `p07b-crosssource-labs-beta.json` | **Cross-source exact lab duplicates.** Same LOINC codes, same values, byte-identical `effectiveDateTime`, two different systems, imported in two batches. The tier-0 reconciliation shape. |
| P07-SHARED-LABEL | same two fixtures, one `--source-system` | **Same-source guard defeated by the transport label.** The two exports arrive under one import-batch label (the Apple Health shape), and the guard that exists to stop same-source records comparing stops the cross-source duplicates comparing too. |
| P08 | `p08a-repeat-vitals-alpha.json`, `p08b-repeat-vitals-beta.json` | **Same-source repeat vitals plus a clock-skew duplicate.** Three blood-pressure readings hours apart on one day at one practice, which must never merge, and a fourth from a second system 17 minutes after the third, which is the same cuff reading and should. |
| P09 | `p09a-med-chains-alpha.json`, `p09b-med-chains-beta.json` | **Medication chains.** Dose supersession (10 mg stopped / 20 mg active), stale-active (one active against two stopped from another prescriber), and the same dose disagreement asked twice: once through `MedicationStatement.dosage` and once through `MedicationRequest.dosageInstruction`. |
| P10 | `p10-allergy-sentinels-fhir.json` | **Allergy sentinels.** A real allergen, a "No Known Allergies" negation, an "Unknown Allergen" data-absent marker, and a real allergen with sparse detail. Three different meanings, one record shape. |
| P11 | `p11-panel-name-variants-fhir.json` | **Panel display-name variants over shared results.** One lipid draw reported three times as "Lipid Panel", "Lipid Profile" and "LIPID PROFILE - Final result", every report pointing at the same four Observations. |
| P12 | `p12-vendor-defects-a-ccda.xml`, `p12-vendor-defects-b-ccda.xml` | **Vendor-shipped defects.** An unsubstituted template placeholder as the document id, a malformed nine-digit date, an empty `nullFlavor` section, and `nullFlavor` variety on values. |
| P13 | `p13-unnamed-org-fhir.json`, `p13-unnamed-org-ccda.xml` | **Unnamed-organization split.** The same system as P01's shape, except the FHIR half names no organization anywhere: no `Organization` resource, no institution-looking provider display, only the endpoint domain. P01 is fixed by preferring a stated organization name over the domain; this one cannot be, because there is no stated name, so the two transports agree only if the display label is derived from the canonical origin. |

## What the harness asserts

For each scenario, in order: `cascade convert` (records in), `cascade pod init`,
`cascade pod import --reconcile-existing` once per batch (records out, merges,
edges), `cascade pod conflicts` (conflicts), `cascade validate` (violations),
and a census of the pod's record subjects by type.

The expected numbers in the harness are the numbers this pipeline produces
TODAY. Where today's number is WRONG, the wrongness is named in the
`KNOWN_OUTCOMES` ledger with the outcome that must replace it, and the ledger is
a gate in both directions: a new deviation fails the suite, and so does a
silently corrected one. The ledger can only shrink deliberately.

Two scenarios carry a constructed ground truth about which records denote the
same clinical event (P07 and its shared-label variant, and P08). For those the
harness measures the reconciler's per-scenario precision and recall over merge
PAIRS and compares them against a committed baseline. It does not assert the
numbers are good. It asserts they are known.
