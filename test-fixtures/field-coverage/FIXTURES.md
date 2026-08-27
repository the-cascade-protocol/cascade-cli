# Field-coverage fixture corpus: provenance and licensing

These fixtures drive `tests/fhir-field-coverage.test.ts`, the differential gate
that requires every populated FHIR element to either reach the converted output
or sit on a converter's drop manifest with a written reason.

## What these fixtures are, and what they are not

**Every fixture is hand-authored and every value in it is invented.** No fixture
is an export, a redaction, or a transformation of any real person's record. The
names, identifiers, dates, addresses, phone numbers, lot numbers, member ids and
free-text notes are fabrications chosen to look like the real thing.

What IS copied from reality is the **shape**: which elements a production EHR
populates, how deeply they nest, and which of them repeat. An Epic R4 pull states
four `Encounter.type` codings and four typed `participant` entries where the FHIR
spec only permits them, and a fixture that states one of each would prove the
converter handles a case that does not occur. The shapes here are modelled on
observed Epic R4 output; vendor-specific identifier systems appear as
`urn:oid:1.2.840.114350.1.13.999.*`, where `999` is a placeholder in place of any
real organization's assigning-authority arc, and vendor extension URLs use
`vendor.example`.

Where two elements can express the same value, the fixture states **different**
values for them wherever a real record plausibly would. The differential deletes
one element at a time, so two elements agreeing on a value both measure as
dropped — with either one gone the other still produces the same output — and the
manifest then describes the fixture rather than the converter.
`documentreference.json` is the case that taught this: its `author` and
`authenticator` both named the attending physician, so when the provenance pass
learned to read them, neither could be observed to flip. The note is now authored
by the resident and attested by the attending, which is both the ordinary shape of
a supervised note and the shape that lets the instrument see the difference.

References are deliberately **relative** (`Practitioner/fc-practitioner-attender`)
rather than absolute. The provenance pass derives a record's source EHR from the
first absolute reference host it finds anywhere in a resource, so an absolute URL
would make unrelated deletions change the output and the differential would
report fields as kept that are not.

## Per-fixture provenance

| Fixture | Resource | Origin | Terminologies used | License notes |
|---|---|---|---|---|
| `allergyintolerance.json` | AllergyIntolerance | Hand-authored | SNOMED CT (International), HL7 terminology | SNOMED via GPS, see below |
| `condition.json` | Condition | Hand-authored | SNOMED CT (International), ICD-10-CM, HL7 terminology | ICD-10-CM is US public domain |
| `coverage.json` | Coverage | Hand-authored | HL7 terminology only | No licensed content |
| `diagnosticreport.json` | DiagnosticReport | Hand-authored | LOINC, SNOMED CT (International), HL7 v2 table | LOINC redistributable with attribution |
| `documentreference.json` | DocumentReference | Hand-authored | LOINC, IHE format codes | LOINC redistributable with attribution |
| `encounter.json` | Encounter | Hand-authored | SNOMED CT (International), HL7 v3 ParticipationType, HL7 admit-source / discharge-disposition | SNOMED via GPS, see below |
| `immunization.json` | Immunization | Hand-authored | CVX, HL7 v3 ActSite / RouteOfAdministration, UCUM | CVX is US public domain |
| `medicationrequest.json` | MedicationRequest | Hand-authored | RxNorm, HL7 terminology, UCUM | RxNorm is US public domain |
| `observation-lab.json` | Observation (lab) | Hand-authored | LOINC, HL7 ObservationInterpretation, UCUM | LOINC redistributable with attribution |
| `patient.json` | Patient | Hand-authored | HL7 v3 MaritalStatus, BCP 47 | No licensed content |

**No CPT code appears in any fixture, and none may be added.** The `Procedure`
converter can emit `clinical:cptCode`, so a Procedure fixture added later must
exercise that path with a SNOMED procedure code only.

Every SNOMED CT concept used here is from the **International Edition**, drawn
from the small set that appears verbatim in HL7's own published FHIR examples,
with the description copied exactly:

| Code | Description as written | Used in |
|---|---|---|
| 185349003 | Encounter for check up | `encounter.json` |
| 195967001 | Asthma | `condition.json` |
| 227493005 | Cashew nuts | `allergyintolerance.json` |
| 39579001 | Anaphylactic reaction | `allergyintolerance.json` |
| 271737000 | Anemia | `diagnosticreport.json` |

No US Edition (or any other national extension) concept is used, which keeps this
corpus distributable outside the United States along with the rest of this
repository.

## Attribution

This material includes SNOMED Clinical Terms (SNOMED CT) identifiers and
descriptions from the SNOMED International Global Patient Set, used under the
Creative Commons Attribution-NoDerivatives 4.0 International License. SNOMED and
SNOMED CT are registered trademarks of SNOMED International.

## Adding a fixture

1. Add the resource here, all values invented, references relative.
2. Add a row to the table above, and to the SNOMED table if it uses SNOMED.
3. Add a drop manifest for its resource type under
   `src/lib/fhir-converter/field-coverage/manifests/` — the gate fails a fixture
   whose type has no manifest, and fails a manifest whose type has no fixture.
4. Run the gate. It will name every populated element that reaches nothing; each
   one needs an entry with a reason, or a converter that emits it.
