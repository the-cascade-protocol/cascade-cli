/**
 * Wave 4: the fields that had nowhere to go until clinical v1.16 / coverage v1.5.
 *
 * WHAT THIS WAVE IS
 * -----------------
 * Waves 1-3 fixed everything the existing vocabulary could already carry, and
 * each one ended by writing down what it could not. Those written-down drops
 * became `spec` PR #31. This suite is the other half of that transaction: every
 * predicate the release authored, emitted by the converter that had been
 * dropping the field, and asserted here so the vocabulary cannot go back to
 * being defined-but-unwritten.
 *
 * The three groups, and the defect each one closes:
 *
 *   ENCOUNTER. `convertEncounter` emitted nine facts about a visit while the
 *   source stated the reason, the admission detail, the readable class label and
 *   the whole care team. Measured over 54 Epic R4 Encounters: `reasonCode`
 *   present on 44 and emitted 0 times; `hospitalization` on 11, emitted 0;
 *   `class.display` on 58, emitted 0 (the pod said `encounterClass "5"` where
 *   the resource said `Appointment`); 128 participants across 56 encounters, of
 *   which 52 names were kept and every role, every specialty and every
 *   participant past the selected one was discarded.
 *
 *   IDENTIFIERS. Per the ratified migration plan, `clinical:businessIdentifier`
 *   is the canonical home for `Encounter.identifier` and uses FHIR TOKEN form,
 *   `{system}|{value}`, with the system verbatim. `cascade:sourceRecordId` keeps
 *   emitting the FROZEN colon form. The two forms are never compared against
 *   each other; `tests/encounter-identifier-join.test.ts` holds that seam.
 *
 *   DOCUMENTS AND COVERAGE. A DocumentReference carries two independent status
 *   elements and two independent attribution facts, and through v1.15 each pair
 *   had one predicate, so each pair's second member was dropped: a superseded
 *   reference read as a live one, and a note signed by an attending read as
 *   though the attending wrote it. `Coverage.status` is the one element FHIR
 *   REQUIRES a Coverage to carry and the coverage vocabulary had no property for
 *   it at all, so a cancelled policy imported indistinguishably from an active
 *   one.
 *
 * Every fixture is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';

import {
  convertClinicalDocument,
  convertEncounter,
} from '../src/lib/fhir-converter/converters-clinical.js';
import { convertCoverage } from '../src/lib/fhir-converter/converters-demographics.js';
import { NS } from '../src/lib/fhir-converter/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Quadish = {
  subject: { value: string };
  predicate: { value: string };
  object: { value: string };
};
type Converted = { _quads: Quadish[] };

function valuesOf(result: Converted, predicate: string): string[] {
  return result._quads.filter((q) => q.predicate.value === predicate).map((q) => q.object.value);
}

function valueOf(result: Converted, predicate: string): string | undefined {
  return valuesOf(result, predicate)[0];
}

/** The values of `predicate` on ONE subject, rather than anywhere in the output. */
function valuesOn(result: Converted, subject: string, predicate: string): string[] {
  return result._quads
    .filter((q) => q.subject.value === subject && q.predicate.value === predicate)
    .map((q) => q.object.value);
}

const RDF_TYPE = NS.rdf + 'type';
const ENCOUNTER_CLASS = NS.clinical + 'encounterClass';
const CLASS_DISPLAY = NS.clinical + 'encounterClassDisplay';
const CLASS_SYSTEM = NS.clinical + 'encounterClassSystem';
const REASON = NS.clinical + 'encounterReason';
const ADMIT_SOURCE = NS.clinical + 'admitSource';
const DISCHARGE = NS.clinical + 'dischargeDisposition';
const HAS_PARTICIPANT = NS.clinical + 'hasParticipant';
const PARTICIPANT_NAME = NS.clinical + 'participantName';
const PARTICIPANT_ROLE = NS.clinical + 'participantRole';
const PARTICIPANT_ROLE_CODE = NS.clinical + 'participantRoleCode';
const PARTICIPANT_SPECIALTY = NS.clinical + 'participantSpecialty';
const PARTICIPANT_CLASS = NS.clinical + 'EncounterParticipant';
const BUSINESS_ID = NS.clinical + 'businessIdentifier';
const CASCADE_SOURCE_RECORD_ID = NS.cascade + 'sourceRecordId';
const PROVIDER_NAME = NS.clinical + 'providerName';
const DOC_REFERENCE_STATUS = NS.clinical + 'documentReferenceStatus';
const DOC_AUTHOR_NAME = NS.clinical + 'documentAuthorName';
const AUTHENTICATOR_NAME = NS.clinical + 'authenticatorName';
const STATUS = NS.clinical + 'status';
const COVERAGE_STATUS = NS.coverage + 'status';

/**
 * The measured Epic shape, reduced: a dermatology office visit whose first
 * participant slot holds a REFERRER, whose treating clinician is the attender
 * with the specialty extension, and which states two reasons, an admission
 * detail, a local class code with its display, and a contact serial number.
 */
function encounterResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'Encounter',
    id: 'enc-derm-1',
    status: 'finished',
    class: {
      system: 'urn:oid:1.2.840.114350.1.72.1.7.1',
      code: '5',
      display: 'Appointment',
    },
    identifier: [
      {
        system: 'urn:oid:1.2.840.114350.1.13.999.2.7.3.698084.8',
        value: '20100000001',
      },
    ],
    reasonCode: [
      { text: 'Derm Problem' },
      {
        coding: [
          { system: 'http://snomed.info/sct', code: '185349003', display: 'Encounter for check up' },
        ],
      },
    ],
    hospitalization: {
      admitSource: { text: 'From outpatient department' },
      dischargeDisposition: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/discharge-disposition', code: 'home', display: 'Home' }],
      },
    },
    participant: [
      {
        type: [{ text: 'referrer', coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'REF', display: 'referrer' }] }],
        individual: { display: 'Lucia Marsh, MD' },
      },
      {
        type: [{ text: 'attender', coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' }] }],
        extension: [
          {
            url: 'https://vendor.example/fhir/StructureDefinition/participant-specialty',
            valueCodeableConcept: { text: 'Dermatology' },
          },
        ],
        individual: { display: 'Amara Okoye, MD' },
      },
    ],
    period: { start: '2025-04-01T16:00:00Z', end: '2025-04-01T16:40:00Z' },
    ...overrides,
  };
}

function documentReference(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'DocumentReference',
    id: 'doc-progress-1',
    status: 'superseded',
    docStatus: 'amended',
    type: { text: 'Progress Notes' },
    date: '2025-04-01T18:22:00Z',
    author: [
      { display: 'Noor Habib, MD' },
      { display: 'Amara Okoye, MD' },
    ],
    authenticator: { display: 'Priya Raman, MD' },
    ...overrides,
  };
}

function coverageResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'Coverage',
    id: 'cov-ppo-1',
    status: 'cancelled',
    type: { coding: [{ code: 'PPO' }] },
    subscriberId: 'MEM-88213400',
    payor: [{ display: 'Cascade Mutual Health' }],
    ...overrides,
  };
}

/** The participant nodes a conversion minted, as subject IRIs. */
function participantNodes(result: Converted): string[] {
  return result._quads
    .filter((q) => q.predicate.value === RDF_TYPE && q.object.value === PARTICIPANT_CLASS)
    .map((q) => q.subject.value);
}

// ---------------------------------------------------------------------------
// Encounter: the visit's own facts
// ---------------------------------------------------------------------------

describe('Encounter reason, admission and class display', () => {
  it('emits every reasonCode, as the text the chart used', () => {
    const result = convertEncounter(encounterResource()) as Converted;
    // Second entry states no `.text`, so the first coding's display is the
    // reason as written. Neither is normalized to a code: the FHIR binding is
    // PREFERRED and real exports carry local, free-text and SNOMED reasons in
    // the same element.
    expect(valuesOf(result, REASON).sort()).toEqual(['Derm Problem', 'Encounter for check up']);
  });

  it('emits admitSource and dischargeDisposition from hospitalization', () => {
    const result = convertEncounter(encounterResource()) as Converted;
    expect(valueOf(result, ADMIT_SOURCE)).toBe('From outpatient department');
    expect(valueOf(result, DISCHARGE)).toBe('Home');
  });

  it('an encounter with no hospitalization element states neither', () => {
    // Presence of hospitalization is itself the signal that a visit was an
    // admission. Defaulting either predicate would erase that distinction in
    // the direction 3.257 was filed for.
    const noAdmission = encounterResource();
    delete (noAdmission as Record<string, unknown>).hospitalization;
    const result = convertEncounter(noAdmission) as Converted;
    expect(valuesOf(result, ADMIT_SOURCE)).toEqual([]);
    expect(valuesOf(result, DISCHARGE)).toEqual([]);
  });

  it('emits the class display and system ALONGSIDE the code, never instead of it', () => {
    // The code is what a round-trip export must restore, so "store the readable
    // one instead" was never available. All three, or the value is either
    // unreadable or unrestorable.
    const result = convertEncounter(encounterResource()) as Converted;
    expect(valueOf(result, ENCOUNTER_CLASS)).toBe('5');
    expect(valueOf(result, CLASS_DISPLAY)).toBe('Appointment');
    expect(valueOf(result, CLASS_SYSTEM)).toBe('urn:oid:1.2.840.114350.1.72.1.7.1');
  });

  it('a class stated as a coding rather than inline is read the same way', () => {
    const result = convertEncounter(
      encounterResource({
        class: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' }] },
      }),
    ) as Converted;
    expect(valueOf(result, ENCOUNTER_CLASS)).toBe('AMB');
    expect(valueOf(result, CLASS_DISPLAY)).toBe('ambulatory');
    expect(valueOf(result, CLASS_SYSTEM)).toBe('http://terminology.hl7.org/CodeSystem/v3-ActCode');
  });
});

// ---------------------------------------------------------------------------
// Encounter: the care team
// ---------------------------------------------------------------------------

describe('Encounter participants', () => {
  it('emits one EncounterParticipant node per participation, not one name', () => {
    const result = convertEncounter(encounterResource()) as Converted;
    const nodes = participantNodes(result);
    expect(nodes).toHaveLength(2);
    expect(valuesOf(result, HAS_PARTICIPANT).sort()).toEqual([...nodes].sort());
  });

  it('each node carries the name, the role, the role code and the specialty', () => {
    const result = convertEncounter(encounterResource()) as Converted;
    const nodes = participantNodes(result);
    const byName = new Map(
      nodes.map((n) => [valuesOn(result, n, PARTICIPANT_NAME)[0], n] as const),
    );

    const attender = byName.get('Amara Okoye, MD');
    expect(attender, 'the attender must be a node of its own').toBeDefined();
    expect(valuesOn(result, attender!, PARTICIPANT_ROLE)).toEqual(['attender']);
    expect(valuesOn(result, attender!, PARTICIPANT_ROLE_CODE)).toEqual(['ATND']);
    expect(valuesOn(result, attender!, PARTICIPANT_SPECIALTY)).toEqual(['Dermatology']);

    const referrer = byName.get('Lucia Marsh, MD');
    expect(referrer, 'the referrer is kept too, WITH its role').toBeDefined();
    expect(valuesOn(result, referrer!, PARTICIPANT_ROLE)).toEqual(['referrer']);
    expect(valuesOn(result, referrer!, PARTICIPANT_ROLE_CODE)).toEqual(['REF']);
    // The source stated no specialty for this one, and none is invented.
    expect(valuesOn(result, referrer!, PARTICIPANT_SPECIALTY)).toEqual([]);
  });

  it('STABILITY PIN: the single providerName slot still selects by role, unchanged', () => {
    // Participants are the full record; providerName is the summary slot an
    // application displays. Wave 1 fixed WHICH name lands in it and this change
    // must not disturb that: the attender wins, not the referrer in slot 0.
    const result = convertEncounter(encounterResource()) as Converted;
    expect(valuesOf(result, PROVIDER_NAME)).toEqual(['Amara Okoye, MD']);
  });

  it('a participant with a name but no role is kept, with no role invented', () => {
    const result = convertEncounter(
      encounterResource({ participant: [{ individual: { display: 'Jordan Vance, RN' } }] }),
    ) as Converted;
    const nodes = participantNodes(result);
    expect(nodes).toHaveLength(1);
    expect(valuesOn(result, nodes[0], PARTICIPANT_NAME)).toEqual(['Jordan Vance, RN']);
    expect(valuesOn(result, nodes[0], PARTICIPANT_ROLE)).toEqual([]);
    expect(valuesOn(result, nodes[0], PARTICIPANT_ROLE_CODE)).toEqual([]);
  });

  it('a participation the source stated nothing about mints no node', () => {
    // An empty participation is not a person the pod can say anything about,
    // and a node carrying only a link back to its encounter asserts a
    // participation that the source did not describe.
    const result = convertEncounter(
      encounterResource({ participant: [{ period: { start: '2025-04-01T16:00:00Z' } }] }),
    ) as Converted;
    expect(participantNodes(result)).toEqual([]);
    expect(valuesOf(result, HAS_PARTICIPANT)).toEqual([]);
  });

  it('an encounter with no participant array emits no participation', () => {
    const bare = encounterResource();
    delete (bare as Record<string, unknown>).participant;
    const result = convertEncounter(bare) as Converted;
    expect(participantNodes(result)).toEqual([]);
  });

  it('keeps every role CODE a participation states, and exactly one role LABEL', () => {
    // The asymmetry is the shape's, not an accident: clinical:participantRole is
    // sh:maxCount 1 and clinical:participantRoleCode is 0..*, matching FHIR's
    // repeating participant.type. Emitting two labels would produce a record
    // that fails validation; dropping the second CODE would lose a role the
    // source stated. So: all the codes, the first label.
    const result = convertEncounter(
      encounterResource({
        participant: [
          {
            type: [
              { coding: [{ code: 'ATND', display: 'attender' }] },
              { coding: [{ code: 'PPRF', display: 'primary performer' }] },
            ],
            individual: { display: 'Amara Okoye, MD' },
          },
        ],
      }),
    ) as Converted;
    const node = participantNodes(result)[0];
    expect(valuesOn(result, node, PARTICIPANT_ROLE_CODE).sort()).toEqual(['ATND', 'PPRF']);
    expect(valuesOn(result, node, PARTICIPANT_ROLE)).toEqual(['attender']);
  });
});

// ---------------------------------------------------------------------------
// Encounter: identifiers
// ---------------------------------------------------------------------------

describe('Encounter business identifiers', () => {
  it('emits businessIdentifier in FHIR token form, system VERBATIM', () => {
    // Token form is `{system}|{value}` per FHIR search. The system is NOT
    // stripped of `urn:oid:` here: that stripping belongs to the frozen colon
    // form and to nothing else, and inventing a second spelling of a canonical
    // form is how the two id spaces became indistinguishable in the first place.
    const result = convertEncounter(encounterResource()) as Converted;
    expect(valuesOf(result, BUSINESS_ID)).toEqual([
      'urn:oid:1.2.840.114350.1.13.999.2.7.3.698084.8|20100000001',
    ]);
  });

  it('an identifier with no system is written bare, and no system is invented', () => {
    const result = convertEncounter(
      encounterResource({ identifier: [{ value: '20100000001' }] }),
    ) as Converted;
    expect(valuesOf(result, BUSINESS_ID)).toEqual(['20100000001']);
  });

  it('emits every identifier the resource states, because the element is 0..*', () => {
    const result = convertEncounter(
      encounterResource({
        identifier: [
          { system: 'urn:oid:1.2.3', value: 'A' },
          { system: 'http://example.org/visit', value: 'B' },
        ],
      }),
    ) as Converted;
    expect(valuesOf(result, BUSINESS_ID).sort()).toEqual([
      'http://example.org/visit|B',
      'urn:oid:1.2.3|A',
    ]);
  });

  it('an identifier with no value emits nothing on either predicate', () => {
    // A system with no value identifies nothing, and `system|` would sit in the
    // join space matching every other value-less identifier from that system.
    const result = convertEncounter(
      encounterResource({ identifier: [{ system: 'urn:oid:1.2.3' }] }),
    ) as Converted;
    expect(valuesOf(result, BUSINESS_ID)).toEqual([]);
    expect(valuesOf(result, CASCADE_SOURCE_RECORD_ID)).toEqual([]);
  });

  it('FROZEN: cascade:sourceRecordId keeps the colon form, urn:oid: stripped', () => {
    // The compatibility artifact. It is dual-written unchanged so that pods
    // repaired before this release still converge, and it is never re-spelled:
    // changing it in place would unjoin every encounter pair already matched on
    // it. Retirement is schedulable only after the canonical predicate is
    // everywhere.
    const result = convertEncounter(encounterResource()) as Converted;
    expect(valuesOf(result, CASCADE_SOURCE_RECORD_ID)).toEqual([
      '1.2.840.114350.1.13.999.2.7.3.698084.8:20100000001',
    ]);
  });

  it('the two forms are DIFFERENT strings for one identifier, and both are present', () => {
    // Stated as its own case because it is the invariant the matcher depends
    // on: a colon-form value and a token-form value for the same identifier do
    // not compare equal, so a matcher that pooled them would either miss real
    // matches or manufacture false ones.
    const result = convertEncounter(encounterResource()) as Converted;
    const token = valuesOf(result, BUSINESS_ID)[0];
    const colon = valuesOf(result, CASCADE_SOURCE_RECORD_ID)[0];
    expect(token).toBeDefined();
    expect(colon).toBeDefined();
    expect(token).not.toBe(colon);
  });

  it('STABILITY PIN: clinical:sourceRecordId still holds the SERVER row id', () => {
    const result = convertEncounter(encounterResource()) as Converted;
    expect(valuesOf(result, NS.clinical + 'sourceRecordId')).toEqual(['enc-derm-1']);
  });
});

// ---------------------------------------------------------------------------
// DocumentReference
// ---------------------------------------------------------------------------

describe('DocumentReference status, authorship and attestation', () => {
  it('emits documentReferenceStatus from status, and keeps docStatus on clinical:status', () => {
    // The pair FHIR keeps separate because "entered-in-error" appears in BOTH
    // value sets and means different things in each.
    const result = convertClinicalDocument(documentReference()) as Converted;
    expect(valueOf(result, DOC_REFERENCE_STATUS)).toBe('superseded');
    expect(valueOf(result, STATUS)).toBe('amended');
  });

  it('a DocumentReference stating neither status emits neither', () => {
    const bare = documentReference();
    delete (bare as Record<string, unknown>).status;
    delete (bare as Record<string, unknown>).docStatus;
    const result = convertClinicalDocument(bare) as Converted;
    expect(valuesOf(result, DOC_REFERENCE_STATUS)).toEqual([]);
    expect(valuesOf(result, STATUS)).toEqual([]);
  });

  it('emits EVERY author, not only the first', () => {
    const result = convertClinicalDocument(documentReference()) as Converted;
    expect(valuesOf(result, DOC_AUTHOR_NAME)).toEqual(['Noor Habib, MD', 'Amara Okoye, MD']);
  });

  it('emits the authenticator as attestation, distinct from authorship', () => {
    // A resident authors and an attending signs. Recording only the author
    // loses the signature; recording the signer as an author asserts they wrote
    // the content, which the source did not say.
    const result = convertClinicalDocument(documentReference()) as Converted;
    expect(valueOf(result, AUTHENTICATOR_NAME)).toBe('Priya Raman, MD');
    expect(valuesOf(result, DOC_AUTHOR_NAME)).not.toContain('Priya Raman, MD');
  });

  it('a document with no authenticator states none', () => {
    const noAuth = documentReference();
    delete (noAuth as Record<string, unknown>).authenticator;
    const result = convertClinicalDocument(noAuth) as Converted;
    expect(valuesOf(result, AUTHENTICATOR_NAME)).toEqual([]);
  });

  it('an author with a reference but no display contributes no name', () => {
    const result = convertClinicalDocument(
      documentReference({ author: [{ reference: 'Practitioner/p1' }, { display: 'Noor Habib, MD' }] }),
    ) as Converted;
    expect(valuesOf(result, DOC_AUTHOR_NAME)).toEqual(['Noor Habib, MD']);
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe('Coverage status', () => {
  it('emits coverage:status, so a cancelled plan no longer reads as an active one', () => {
    const result = convertCoverage(coverageResource()) as Converted;
    expect(valueOf(result, COVERAGE_STATUS)).toBe('cancelled');
  });

  it('a Coverage stating no status emits none', () => {
    // FHIR makes the element 1..1, so a resource without it is non-conformant
    // at source. Substituting "active" for a missing modifier element is the
    // 3.257 defect on the field where it costs the most.
    const bare = coverageResource();
    delete (bare as Record<string, unknown>).status;
    const result = convertCoverage(bare) as Converted;
    expect(valuesOf(result, COVERAGE_STATUS)).toEqual([]);
  });

  it('the status does not land on clinical:status', () => {
    // coverage: is its own namespace and an insurance plan is not a clinical
    // record. Borrowing across the split was the option this release removed.
    const result = convertCoverage(coverageResource()) as Converted;
    expect(valuesOf(result, STATUS)).toEqual([]);
  });
});
