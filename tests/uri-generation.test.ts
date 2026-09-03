/**
 * Contract tests for deterministicUuid / contentHashedUri.
 *
 * These tests lock in the exact output values that define the Cascade URI
 * derivation spec.  Any change to the hashing algorithm will cause these
 * tests to fail — that is intentional.  Before changing an algorithm,
 * coordinate with all SDK ports (TypeScript, Python, Swift) so they ship
 * matching changes simultaneously.
 *
 * Algorithm reference (copy of the doc-comment in types.ts):
 *   Input:   UTF-8 string
 *   Hash:    SHA-1(input) -> 40-char lowercase hex digest `h`
 *   Layout:  {h[0:8]}-{h[8:12]}-5{h[13:16]}-{v}{h[18:20]}-{h[20:32]}
 *            where v = (parseInt(h[16:18], 16) & 0x3f | 0x80).toString(16).padStart(2,'0')
 */

import { describe, it, expect } from 'vitest';
import {
  contentHashedUri,
  mintSubjectUri,
  medicationUri,
  codeableConceptKey,
  codeableConceptSetKey,
  canonicalSetKey,
  encounterParticipantUri,
} from '../src/lib/fhir-converter/types.js';

describe('deterministicUuid cross-SDK contract', () => {
  it('SHA-1("hello") produces the canonical UUID', () => {
    // contentHashedUri("X", { k: "hello" }) builds identity "X::k=hello"
    // SHA-1("X::k=hello") = 8d332657...
    // -> urn:uuid:8d332657-5b2e-59bb-aeef-5f78bab37a8a
    const uri = contentHashedUri('X', { k: 'hello' });
    expect(uri).toBe('urn:uuid:8d332657-5b2e-59bb-aeef-5f78bab37a8a');
  });

  it('Patient identity fields produce a stable URI', () => {
    // Canonical test vector from types.ts doc-comment:
    //   identity: "Patient::dob=1985-03-15|family=Smith|given=John|sex=male"
    //   -> urn:uuid:aba8c9f5-fdc6-5187-a363-0d5a7cb72438
    const uri = contentHashedUri('Patient', {
      dob: '1985-03-15',
      sex: 'male',
      family: 'Smith',
      given: 'John',
    });
    expect(uri).toBe('urn:uuid:aba8c9f5-fdc6-5187-a363-0d5a7cb72438');
  });

  it('keys are sorted ascending before hashing', () => {
    const ordered   = contentHashedUri('T', { a: '1', b: '2', c: '3' });
    const unordered = contentHashedUri('T', { c: '3', a: '1', b: '2' });
    expect(ordered).toBe(unordered);
  });

  it('undefined and empty values are excluded from identity string', () => {
    const withEmpty    = contentHashedUri('T', { a: '1', b: '', c: undefined });
    const withoutEmpty = contentHashedUri('T', { a: '1' });
    expect(withEmpty).toBe(withoutEmpty);
  });

  it('mintSubjectUri preserves a valid UUID v4 resource id unchanged', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const uri = mintSubjectUri({ resourceType: 'Patient', id });
    expect(uri).toBe(`urn:uuid:${id}`);
  });

  it('mintSubjectUri hashes a non-UUID resource id deterministically', () => {
    const uri1 = mintSubjectUri({ resourceType: 'Condition', id: 'epic-12345' });
    const uri2 = mintSubjectUri({ resourceType: 'Condition', id: 'epic-12345' });
    expect(uri1).toBe(uri2);
    expect(uri1).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('medicationUri matches the cross-port conformance vector (and normalizes the name)', () => {
    // Vector `medication-lisinopril-rxnorm`:
    //   MedicationRequest::normalizedName=lisinopril|patient=urn:uuid:patient-smith|rxNormCode=29046|startDate=2020-04-01
    //   -> urn:uuid:f181c773-4c66-5cd3-96d7-5ff69c472fea
    // The raw name "Lisinopril 10 mg" must normalize to "lisinopril" so dose
    // variants share one identity (dose is NOT part of the URI).
    const uri = medicationUri({
      rxNormCode: '29046',
      medicationName: 'Lisinopril 10 mg',
      startDate: '2020-04-01',
      patient: 'urn:uuid:patient-smith',
    });
    expect(uri).toBe('urn:uuid:f181c773-4c66-5cd3-96d7-5ff69c472fea');
  });

  it('medicationUri excludes dose: 10 mg and 20 mg of the same drug share a URI', () => {
    const base = { rxNormCode: '29046', startDate: '2020-04-01', patient: 'urn:uuid:p1' };
    expect(medicationUri({ ...base, medicationName: 'Lisinopril 10 mg' }))
      .toBe(medicationUri({ ...base, medicationName: 'Lisinopril 20 mg' }));
  });
});

// ---------------------------------------------------------------------------
// Canonical form of a SET-valued identity input (core v3.6)
//
// The rule is stated normatively on cascade:cascadeUri in spec: discard empty
// members, deduplicate, sort by code point, join with a fixed separator, and a
// one-element sequence canonicalizes to the bare scalar.
//
// THE GOLDEN PINS BELOW ARE THE POINT OF THIS BLOCK. The three invariants are
// worth testing, but the claim that actually had to be proved before shipping is
// the NEGATIVE one: that adding dedupe to these key builders moved no identity
// that had already been written. So the single-code and scalar cases are pinned
// to literal URIs, not to each other. A test that only compares two computed
// values passes just as happily when both have moved.
// ---------------------------------------------------------------------------

describe('canonical form of a set-valued identity input (core v3.6)', () => {
  // The URI a single-coding CodeableConcept minted BEFORE dedupe was added.
  //
  // HOW THIS VALUE WAS OBTAINED, because a golden pin copied out of the run it is
  // meant to constrain proves nothing. Three independent derivations agree:
  //   1. An independent SHA-1 implementation applied to the identity string
  //      "Observation::code=http://loinc.org|2339-0" by hand.
  //   2. This module's code at origin/main, i.e. BEFORE canonicalSetKey existed.
  //   3. This module's code now.
  // The only output that differs between (2) and (3) anywhere is the duplicate
  // case: codeableConceptSetKey(['medication','food','food']) was
  // "food;food;medication" and is now "food;medication". That single collapse is
  // the whole behavioural change, and it is the defect being corrected.
  const SINGLE_CODING_URI = 'urn:uuid:69d60ee0-84eb-5ecf-be93-c243962b1ae5';

  it('GOLDEN PIN: one coding hashes exactly as it did before dedupe existed', () => {
    // identity string: Observation::code=http://loinc.org|2339-0
    const uri = contentHashedUri('Observation', {
      code: codeableConceptKey({ coding: [{ system: 'http://loinc.org', code: '2339-0' }] }),
    });
    expect(uri).toBe(SINGLE_CODING_URI);
  });

  it('GOLDEN PIN: a scalar field spelled directly hashes to the same URI', () => {
    // SCALAR AGREEMENT. The key builder is not involved at all here: this is the
    // bare string a pre-0..* caller would have passed. It must land on the same
    // value the coding array does, or the two spellings of one record split.
    const uri = contentHashedUri('Observation', { code: 'http://loinc.org|2339-0' });
    expect(uri).toBe(SINGLE_CODING_URI);
  });

  it('GOLDEN PIN: repeating that one coding does not move it', () => {
    // DUPLICATE INDEPENDENCE, pinned to the literal rather than to a comparison,
    // so it also proves the dedupe collapses TO the pre-existing value and not
    // to some new one.
    const uri = contentHashedUri('Observation', {
      code: codeableConceptKey({
        coding: [
          { system: 'http://loinc.org', code: '2339-0' },
          { system: 'http://loinc.org', code: '2339-0' },
        ],
      }),
    });
    expect(uri).toBe(SINGLE_CODING_URI);
  });

  it('ORDER INDEPENDENCE: two exports listing the same codings differently agree', () => {
    const a = codeableConceptKey({
      coding: [
        { system: 'http://snomed.info/sct', code: '73211009' },
        { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9' },
      ],
    });
    const b = codeableConceptKey({
      coding: [
        { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9' },
        { system: 'http://snomed.info/sct', code: '73211009' },
      ],
    });
    expect(a).toBe(b);
    expect(contentHashedUri('Condition', { code: a })).toBe(contentHashedUri('Condition', { code: b }));
  });

  it('a differing SET still differs: canonicalization removes splits, never merges', () => {
    // The guard on the whole change. Sorting and deduping may only collapse
    // spellings of ONE set; if it ever collapsed two different sets, every
    // assertion above would still pass while the converter silently merged
    // distinct records.
    const two = codeableConceptKey({
      coding: [
        { system: 'http://snomed.info/sct', code: '73211009' },
        { system: 'http://snomed.info/sct', code: '44054006' },
      ],
    });
    const one = codeableConceptKey({ coding: [{ system: 'http://snomed.info/sct', code: '73211009' }] });
    expect(two).not.toBe(one);
    expect(contentHashedUri('Condition', { code: two })).not.toBe(contentHashedUri('Condition', { code: one }));
  });

  it('sorts by code point, not by locale', () => {
    // A locale-aware comparator orders these a01, B02, Z01 and would make a
    // record's identity depend on the machine that imported it.
    expect(canonicalSetKey(['Z01', 'a01', 'B02'], ',')).toBe('B02,Z01,a01');
  });

  it('empty and whitespace-only members are discarded, not hashed', () => {
    expect(canonicalSetKey(['2339-0', '', '   '], ',')).toBe('2339-0');
    expect(canonicalSetKey(['', '  '], ',')).toBeUndefined();
    // An all-empty set is ABSENT, and contentHashedUri drops absent fields, so
    // it must hash identically to the field never being supplied.
    expect(contentHashedUri('Observation', { date: '2024-01-10', code: canonicalSetKey([''], ',') }))
      .toBe(contentHashedUri('Observation', { date: '2024-01-10' }));
  });

  it('keeps the separator each existing site already shipped', () => {
    // core v3.6 recommends U+002C and REQUIRES it of new implementations, but
    // lets an existing site keep what it ships, because changing a separator
    // re-mints every identity that site ever produced. codeableConceptSetKey has
    // always joined with ';'. This test is what stops a well-meaning
    // "consistency" edit from silently re-minting every multi-concept record.
    expect(codeableConceptSetKey(['food', 'medication'])).toBe('food;medication');
    expect(canonicalSetKey(['food', 'medication'], ',')).toBe('food,medication');
  });

  it('codeableConceptSetKey deduplicates and orders its members', () => {
    expect(codeableConceptSetKey(['medication', 'food', 'food'])).toBe('food;medication');
    expect(codeableConceptSetKey(['food', 'medication'])).toBe(
      codeableConceptSetKey(['medication', 'food']),
    );
  });
});

/**
 * ORDERING OF IDENTITY KEYS — code point, never locale collation.
 *
 * `spec/ontologies/core/v1/core.ttl`, `cascade:cascadeUri`, "CANONICAL FORM OF
 * A MULTI-VALUED IDENTITY INPUT (v3.6, NORMATIVE)", step 3:
 *
 *   "Sort ascending by Unicode code point. (Code point, not locale collation:
 *    a locale-dependent order would make identity depend on the machine.)"
 *
 * The parenthetical is the whole reason this block exists. `localeCompare`
 * asks ICU for the reader's alphabet, and every Latin-script collation puts
 * `alpha` before `Zeta` while code point puts `Zeta` first, because 'Z' is
 * U+005A and 'a' is U+0061. An identity built on the first answer is a
 * function of the importing MACHINE as well as the record, which is the one
 * property an identifier may not have: the same document imported on two
 * laptops would mint two URIs, the pod would duplicate instead of reconcile,
 * and every cross-reference written by the other machine would dangle.
 *
 * A note on what these tests can and cannot prove. The bug is that behaviour
 * VARIES by machine, so a test cannot be red everywhere by construction — on a
 * hypothetical host whose collation happened to agree with code point, the
 * broken comparator would pass. The first test below is therefore a guard on
 * the guard: it asserts this host's collator really does disagree on the exact
 * key pairs used, so a green run of the rest means the code is right and not
 * that the environment was blind. The expected URIs are hard-coded rather than
 * recomputed, so nothing here can be satisfied by re-deriving the answer from
 * the code under test.
 */
describe('identity keys sort by code point, not locale collation', () => {
  const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  /** The key pairs used below, and which order each ordering rule produces. */
  const DIVERGENT_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['Zeta', 'alpha'],  // uppercase letter vs lowercase letter
    ['Code', 'code'],   // same letters, case differs
    ['_x', 'Ax'],       // punctuation vs letter
  ];

  it('this host really does order these keys two different ways', () => {
    for (const [a, b] of DIVERGENT_PAIRS) {
      expect(byCodePoint(a, b), `${a} vs ${b} by code point`).not.toBe(0);
      expect(
        Math.sign(new Intl.Collator('en-US').compare(a, b)),
        `${a} vs ${b}: collation must DISAGREE with code point, or the tests below are vacuous`,
      ).toBe(-Math.sign(byCodePoint(a, b)));
    }
  });

  it('an uppercase key sorts before a lowercase one', () => {
    // Code point: "T::Zeta=1|alpha=2". Locale collation: "T::alpha=2|Zeta=1",
    // which hashes to urn:uuid:23dee717-0913-50c5-b55e-edbd27b48c0c.
    expect(contentHashedUri('T', { Zeta: '1', alpha: '2' })).toBe(
      'urn:uuid:79a0280d-d048-5472-8f04-b96813250037',
    );
  });

  it('two keys differing only in case sort uppercase first', () => {
    // Code point: "M::Code=1|code=2". Locale collation puts `code` first
    // (tertiary weight), giving urn:uuid:99819f32-b865-5df3-bc87-9ee6eeaafa84.
    expect(contentHashedUri('M', { Code: '1', code: '2' })).toBe(
      'urn:uuid:9e28702a-b965-5cb6-80c3-41ab12c1cd59',
    );
  });

  it('a leading underscore sorts AFTER a letter, where collation puts it first', () => {
    // '_' is U+005F, above 'A' at U+0041, so code point gives "K::Ax=2|_x=1".
    // Collation treats punctuation as sorting before letters and would give
    // "K::_x=1|Ax=2" -> urn:uuid:9d454219-8a8d-55b1-b8f0-9b7e86a853da.
    expect(contentHashedUri('K', { _x: '1', Ax: '2' } as Record<string, string>)).toBe(
      'urn:uuid:f2e00c2e-ca9c-5052-b49a-61012ce918b6',
    );
  });

  it('the order is the same one the rest of this module already uses', () => {
    // Array.prototype.sort with no comparator IS the code-unit order, and the
    // set-key canonicalizer has always used it. The chokepoint now agrees with
    // its own neighbour rather than contradicting it.
    expect(canonicalSetKey(['alpha', 'Zeta'], ',')).toBe('Zeta,alpha');
    expect(['alpha', 'Zeta'].sort().join(',')).toBe('Zeta,alpha');
  });
});

/**
 * GOLDEN IDENTITIES — the migration proof, kept executable.
 *
 * Every field-name set that reaches `contentHashedUri` in production, one row
 * per identity site, with the URI each one mints. These values were computed
 * against the PREVIOUS comparator (`localeCompare`) and are asserted against
 * the current one, so this block is the standing evidence that switching the
 * comparator moved NO identifier that any existing pod can contain: every one
 * of these key sets is drawn from lowercase-initial ASCII camelCase names, on
 * which the two orderings agree exactly.
 *
 * These are contract values in the sense the header of this file describes. A
 * failure here is not a test to update: it means live records have been
 * re-minted and existing pods would duplicate on their next import.
 */
describe('production identity key sets mint unchanged URIs', () => {
  it('FHIR Patient', () => {
    expect(
      contentHashedUri('Patient', {
        dob: '1985-03-15', sex: 'male', name: 'n-8f3a', identifier: 'i-2b7c',
        maritalStatus: 'M', address: 'a-91de', deceased: undefined,
      }),
    ).toBe('urn:uuid:9b1014a4-5129-5585-9972-f1ec31d2f6f8');
  });

  it('FHIR Condition', () => {
    expect(
      contentHashedUri('Condition', {
        patient: 'urn:uuid:pat-1', code: 'http://snomed.info/sct|44054006',
        onset: '2019-06-01T09:30:00Z', abatement: undefined, clinicalStatus: 'active',
        verificationStatus: 'confirmed', category: 'problem-list-item',
        encounter: 'Encounter/e1', note: 'nt-77aa',
      }),
    ).toBe('urn:uuid:16b124fd-1e20-577a-9cde-3b264c14eaf6');
  });

  it('FHIR Observation (lab)', () => {
    expect(
      contentHashedUri('Observation', {
        patient: 'urn:uuid:pat-1', loincCode: '2339-0', effective: '2024-01-10T07:00:00Z',
        value: '95 mg/dL', specimen: 'Specimen/s1', category: 'laboratory', status: 'final',
      }),
    ).toBe('urn:uuid:e7f2278c-1335-55fd-935b-4260633df9f5');
  });

  it('FHIR Immunization', () => {
    expect(
      contentHashedUri('Immunization', {
        patient: 'Patient/p1', vaccine: 'http://hl7.org/fhir/sid/cvx|140',
        occurrence: '2023-10-02', status: 'completed', lotNumber: 'AB-1234', dose: 'd-4411',
        site: 'LA', route: 'IM', manufacturer: 'Acme Biologics', encounter: 'Encounter/e2',
        performer: 'Dr. Okoye', location: 'Clinic North', note: 'nt-1234',
      }),
    ).toBe('urn:uuid:a92218dd-a69e-5b2a-86e2-a144eecc5e9c');
  });

  it('FHIR AllergyIntolerance', () => {
    expect(
      contentHashedUri('AllergyIntolerance', {
        patient: 'Patient/p1', code: 'http://snomed.info/sct|91936005',
        clinicalStatus: 'active', verificationStatus: 'confirmed', type: 'allergy',
        category: 'medication', criticality: 'high', onset: '2011-04-02',
        reaction: 'rx-55ff', note: 'nt-9090',
      }),
    ).toBe('urn:uuid:5bb5bf10-7303-5dd4-accf-eee3bf25668a');
  });

  it('the shared medication key (FHIR and C-CDA both mint here)', () => {
    expect(
      medicationUri({
        rxNormCode: '314076', medicationName: 'Lisinopril 10 MG Oral Tablet',
        startDate: '2022-02-01', patient: 'urn:uuid:pat-1',
      }),
    ).toBe('urn:uuid:f8eb9e78-ba76-529d-8966-bfb2f0a7cbec');
  });

  it('EncounterParticipant', () => {
    expect(
      encounterParticipantUri('urn:uuid:enc-1', {
        name: 'Amara Okoye, MD', role: 'attender',
        roleCodes: ['PPRF', 'ATND'], specialty: 'Cardiology',
      }),
    ).toBe('urn:uuid:64a16e02-b594-5af5-8662-5af0e604f284');
  });

  it('C-CDA lab result', () => {
    expect(
      contentHashedUri('LabResult', {
        loincCode: '2339-0', testName: 'Glucose', value: '95', unit: 'mg/dL',
        effective: '20240110070000', refRange: '70-99',
      }),
    ).toBe('urn:uuid:270dccdc-4dc8-5947-95ae-d7f8a0dd83fd');
  });

  it('C-CDA lab panel', () => {
    expect(
      contentHashedUri('LaboratoryReport', {
        panelCode: '24323-8', panelName: 'Comprehensive metabolic panel',
        date: '20240110', effective: '20240110070000', members: 'm-3311', encounters: 'e-4422',
      }),
    ).toBe('urn:uuid:fc093d7a-4c08-5d1f-916b-01be53c87d9a');
  });

  it('C-CDA problem', () => {
    expect(
      contentHashedUri('Condition', {
        conditionName: 'Type 2 diabetes mellitus', snomedCode: '44054006',
        icd10Code: 'E11.9', onsetDate: '2019-06-01', status: 'active',
      }),
    ).toBe('urn:uuid:c751ec99-9688-5e0d-89eb-dcbf32162886');
  });

  it('C-CDA patient', () => {
    expect(
      contentHashedUri('Patient', {
        name: 'Jane Q Public', dob: '19850315', sex: 'F',
        address: 'a-77bb', telecom: 'tel:+15555550123',
      }),
    ).toBe('urn:uuid:4f000e41-bf1f-53da-8ddb-6f54b4b38cc3');
  });

  it('C-CDA narrative section', () => {
    expect(
      contentHashedUri('ClinicalDocument', {
        document: 'urn:uuid:doc-1', section: '11450-4', source: 'sec-hash-abc',
      }),
    ).toBe('urn:uuid:2f008ac0-75a5-54f1-a7dc-eb1b4217db51');
  });

  it('every production key name is lowercase-initial ASCII camelCase', () => {
    // The premise the goldens above rest on, stated as a check rather than a
    // claim: the two orderings agree on these key sets BECAUSE the names are
    // drawn from this shape. A key carrying an uppercase initial, an
    // underscore, or a non-ASCII character would be the case where they part.
    // Collected from every literal key object passed to an identity minter.
    const PRODUCTION_KEYS = [
      'abatement', 'address', 'allergenName', 'category', 'clinicalStatus', 'code',
      'condition', 'conditionName', 'criticality', 'cvxCode', 'date', 'deceased',
      'displayName', 'dob', 'document', 'dose', 'effective', 'encounter', 'encounters',
      'family', 'given', 'icd10Code', 'identifier', 'location', 'loincCode', 'lotNumber',
      'manufacturer', 'maritalStatus', 'medicationName', 'members', 'name',
      'normalizedName', 'note', 'occurrence', 'onset', 'onsetDate', 'panelCode',
      'panelName', 'patient', 'performer', 'reaction', 'refRange', 'relation',
      'relative', 'role', 'roleCode', 'route', 'rxNormCode', 'section', 'severity',
      'sex', 'site', 'snomedCode', 'source', 'specialty', 'specimen', 'startDate',
      'status', 'telecom', 'testName', 'type', 'unit', 'vaccine', 'vaccineName',
      'value', 'verificationStatus',
    ];
    expect(PRODUCTION_KEYS.filter((k) => !/^[a-z][A-Za-z0-9]*$/.test(k))).toEqual([]);
    // And on THIS set the two orderings are in fact identical, which is the
    // migration statement itself.
    const byCodePoint = [...PRODUCTION_KEYS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const loc of ['en-US', 'de-DE', 'sv-SE', 'tr-TR', 'cs-CZ', 'fr-FR', 'ja-JP']) {
      const collator = new Intl.Collator(loc).compare;
      expect([...PRODUCTION_KEYS].sort(collator), `collation differs under ${loc}`)
        .toEqual(byCodePoint);
    }
  });
});
