/**
 * Encounter deduplication: one visit is one subject, whichever transport carried
 * it and however many documents re-declared it.
 *
 * THE MEASURED DEFECT
 * -------------------
 * A pod holding one Epic account's SMART on FHIR pull AND that account's C-CDA
 * document export held 177 `clinical:Encounter` subjects describing about 58
 * real visits. 123 came from the C-CDA path carrying only 52 distinct visit
 * identifiers (each clinical document re-declares the encounter it was written
 * under), 54 came from the FHIR path, and 48 of the 52 C-CDA identifiers named
 * the SAME visits as FHIR encounters. Neither half could recognise the other,
 * because `clinical:Encounter` was not a reconcilable type at all: encounter
 * quads went through the reconciler as passthrough, never compared with
 * anything.
 *
 * THE JOIN KEY
 * ------------
 * The C-CDA `<encounter><id root= extension=/>` and the FHIR
 * `Encounter.identifier[0]` are the same Epic contact serial number written
 * twice, and both transports now state it on `cascade:sourceRecordId` in the
 * same normalized `system:value` spelling. That is the ONLY key this matcher
 * uses. An encounter that states no identifier never merges with anything:
 * absence of a join key is not evidence of a match, and two undated, untyped
 * visit stubs are not one visit because they are equally empty.
 *
 * All data below is synthetic and PHI-free. The identifier OIDs are in the
 * example-use `.999.` arc, not any real Epic assigning authority.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { runReconciliation } from '../src/lib/reconciler.js';

const CLINICAL = 'https://ns.cascadeprotocol.org/clinical/v1#';
const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
const PROV = 'http://www.w3.org/ns/prov#';

const HAS_ENCOUNTER = CLINICAL + 'hasEncounter';
const ENCOUNTER_TYPE = CLINICAL + 'Encounter';
const MERGED_FROM = CASCADE + 'mergedFrom';
const WAS_DERIVED_FROM = PROV + 'wasDerivedFrom';

const PREFIXES = `@prefix cascade: <${CASCADE}> .
@prefix clinical: <${CLINICAL}> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix prov: <${PROV}> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

/** The contact serial number both transports state for the same visit. */
const CSN = '1.2.840.114350.1.13.999.2.7.3.698084.8:20100000001';
const OTHER_CSN = '1.2.840.114350.1.13.999.2.7.3.698084.8:20100000002';

/**
 * A C-CDA-shaped encounter block: thin, dated, typed, and carrying the document
 * bookkeeping the C-CDA path writes. `subject` varies because each document
 * re-declaring one visit mints its own subject today.
 */
function ccdaEncounter(subject: string, sourceId?: string): string {
  return `<${subject}> a clinical:Encounter ;
  cascade:sourceSystem "providence-ccda" ;
  cascade:sourceIdentity "org:providence" ;
  cascade:dataProvenance cascade:EHRVerified ;
  cascade:schemaVersion "1.0" ;
  cascade:documentType "summarization" ;
  cascade:encounterType "Office Visit" ;
  clinical:encounterType "Office Visit" ;
  clinical:encounterDate "2025-04-01"^^xsd:date ;
  health:effectiveDate "2025-04-01"${sourceId ? ` ;\n  cascade:sourceRecordId "${sourceId}"` : ''} .
`;
}

/** A FHIR-shaped encounter block: the rich one, with clinic, provider, class. */
function fhirEncounter(subject: string, sourceId?: string): string {
  return `<${subject}> a clinical:Encounter ;
  cascade:sourceSystem "providence-fhir" ;
  cascade:sourceIdentity "org:providence" ;
  cascade:dataProvenance cascade:EHRVerified ;
  cascade:schemaVersion "1.0" ;
  clinical:fhirResourceType "Encounter" ;
  clinical:sourceRecordId "eNcOuNtEr-1" ;
  clinical:encounterClass "5" ;
  clinical:encounterStatus "finished" ;
  clinical:encounterType "Ambulatory office visit" ;
  clinical:encounterStart "2025-04-01T16:00:00Z"^^xsd:dateTime ;
  clinical:encounterEnd "2025-04-01T16:45:00Z"^^xsd:dateTime ;
  clinical:providerName "Alex Rivera, MD" ;
  clinical:facilityName "NORTHGATE DERMATOLOGY"${sourceId ? ` ;\n  cascade:sourceRecordId "${sourceId}"` : ''} .
`;
}

function parse(ttl: string) {
  return new Parser({ format: 'Turtle' }).parse(ttl);
}

/** Every subject typed `clinical:Encounter` in a reconciled output. */
function encounterSubjects(ttl: string): string[] {
  return parse(ttl)
    .filter((q) => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && q.object.value === ENCOUNTER_TYPE)
    .map((q) => q.subject.value)
    .sort();
}

function objectsOf(ttl: string, subject: string, predicate: string): string[] {
  return parse(ttl)
    .filter((q) => q.subject.value === subject && q.predicate.value === predicate)
    .map((q) => q.object.value)
    .sort();
}

function valuesOf(ttl: string, predicate: string): string[] {
  return parse(ttl)
    .filter((q) => q.predicate.value === predicate)
    .map((q) => q.object.value)
    .sort();
}

/** Every `clinical:hasEncounter` object that names no encounter subject. */
function danglingEncounterEdges(ttl: string): string[] {
  const subjects = new Set(encounterSubjects(ttl));
  return valuesOf(ttl, HAS_ENCOUNTER).filter((o) => !subjects.has(o));
}

describe('reconciler: encounters converge on the identifier both transports state', () => {
  it('merges the thin C-CDA twin and the rich FHIR twin of one visit into one subject', async () => {
    const result = await runReconciliation([
      { content: `${PREFIXES}${ccdaEncounter('urn:uuid:enc-ccda', CSN)}`, systemName: 'providence-ccda' },
      { content: `${PREFIXES}${fhirEncounter('urn:uuid:enc-fhir', CSN)}`, systemName: 'providence-fhir' },
    ]);

    const subjects = encounterSubjects(result.turtle);
    expect(subjects).toHaveLength(1);

    // The union of facts, not the winner's alone: the clinic came from the FHIR
    // twin and the document type from the C-CDA one, and one visit knows both.
    const survivor = subjects[0];
    expect(objectsOf(result.turtle, survivor, CLINICAL + 'facilityName')).toEqual(['NORTHGATE DERMATOLOGY']);
    expect(objectsOf(result.turtle, survivor, CLINICAL + 'providerName')).toEqual(['Alex Rivera, MD']);
    expect(objectsOf(result.turtle, survivor, CASCADE + 'documentType')).toEqual(['summarization']);
    expect(objectsOf(result.turtle, survivor, CASCADE + 'sourceRecordId')).toEqual([CSN]);
  });

  it('records the absorbed subjects as lineage rather than deleting them silently', async () => {
    const result = await runReconciliation([
      { content: `${PREFIXES}${ccdaEncounter('urn:uuid:enc-ccda', CSN)}`, systemName: 'providence-ccda' },
      { content: `${PREFIXES}${fhirEncounter('urn:uuid:enc-fhir', CSN)}`, systemName: 'providence-fhir' },
    ]);

    const survivor = encounterSubjects(result.turtle)[0];
    const mergedFrom = objectsOf(result.turtle, survivor, MERGED_FROM);
    const derivedFrom = objectsOf(result.turtle, survivor, WAS_DERIVED_FROM);
    expect(mergedFrom).toEqual(['urn:uuid:enc-ccda', 'urn:uuid:enc-fhir']);
    expect(derivedFrom).toEqual(['urn:uuid:enc-ccda', 'urn:uuid:enc-fhir']);
  });

  it('collapses a C-CDA identifier re-declared by three documents in ONE import', async () => {
    // Same batch label AND same origin, which is exactly what the same-source
    // guard normally suppresses. It is right to suppress a heuristic match
    // there; this is not one. The source stated one identifier three times, so
    // the source itself is saying these are one act.
    const result = await runReconciliation([
      {
        content:
          PREFIXES +
          ccdaEncounter('urn:uuid:enc-doc-a', CSN) +
          ccdaEncounter('urn:uuid:enc-doc-b', CSN) +
          ccdaEncounter('urn:uuid:enc-doc-c', CSN),
        systemName: 'providence-ccda',
      },
    ]);

    expect(encounterSubjects(result.turtle)).toHaveLength(1);
  });

  it('never merges two encounters that state no identifier', async () => {
    // Byte-identical apart from their subjects, and still two records. Absence
    // of a join key is not a match, and there is no second tier to fall to.
    const result = await runReconciliation([
      {
        content: PREFIXES + ccdaEncounter('urn:uuid:enc-anon-1') + ccdaEncounter('urn:uuid:enc-anon-2'),
        systemName: 'providence-ccda',
      },
    ]);

    expect(encounterSubjects(result.turtle).length).toBe(2);
  });

  it('never merges an identifier-less encounter into an identified one', async () => {
    const result = await runReconciliation([
      { content: `${PREFIXES}${ccdaEncounter('urn:uuid:enc-anon-1')}`, systemName: 'providence-ccda' },
      { content: `${PREFIXES}${fhirEncounter('urn:uuid:enc-fhir', CSN)}`, systemName: 'providence-fhir' },
    ]);

    expect(encounterSubjects(result.turtle).length).toBe(2);
  });

  it('keeps two visits with different identifiers apart', async () => {
    const result = await runReconciliation([
      { content: `${PREFIXES}${ccdaEncounter('urn:uuid:enc-ccda', CSN)}`, systemName: 'providence-ccda' },
      { content: `${PREFIXES}${fhirEncounter('urn:uuid:enc-fhir', OTHER_CSN)}`, systemName: 'providence-fhir' },
    ]);

    expect(encounterSubjects(result.turtle).length).toBe(2);
  });
});

describe('reconciler: every hasEncounter edge follows the merge', () => {
  const LAB = `<urn:uuid:lab-0001> a health:LabResultRecord ;
  cascade:sourceSystem "providence-ccda" ;
  health:testCode <http://loinc.org/rdf#2339-0> ;
  health:testName "Glucose" ;
  health:resultValue "95" ;
  health:performedDate "2025-04-01T09:15:00Z"^^xsd:dateTime ;
  clinical:hasEncounter <urn:uuid:enc-ccda> .
`;

  const DOCUMENT = `<urn:uuid:doc-0001> a clinical:ClinicalDocument ;
  cascade:sourceSystem "providence-fhir" ;
  clinical:sourceEHR "Providence" ;
  clinical:hasEncounter <urn:uuid:enc-fhir> .
`;

  it('rewrites edges from BOTH a reconciled record and a passthrough one', async () => {
    const result = await runReconciliation([
      { content: `${PREFIXES}${ccdaEncounter('urn:uuid:enc-ccda', CSN)}${LAB}`, systemName: 'providence-ccda' },
      { content: `${PREFIXES}${fhirEncounter('urn:uuid:enc-fhir', CSN)}${DOCUMENT}`, systemName: 'providence-fhir' },
    ]);

    const survivor = encounterSubjects(result.turtle)[0];
    // The lab is a reconciled record; the clinical document is passthrough.
    expect(objectsOf(result.turtle, 'urn:uuid:lab-0001', HAS_ENCOUNTER)).toEqual([survivor]);
    expect(objectsOf(result.turtle, 'urn:uuid:doc-0001', HAS_ENCOUNTER)).toEqual([survivor]);
    expect(danglingEncounterEdges(result.turtle)).toEqual([]);
    expect(result.report.summary.edgeObjectsRewritten).toBeGreaterThan(0);
  });

  it('leaves no dangling edge when three documents re-declared one visit', async () => {
    const edgesTo = (enc: string, n: number) =>
      `<urn:uuid:note-${n}> a clinical:ClinicalDocument ;
  clinical:sourceEHR "Providence" ;
  clinical:hasEncounter <${enc}> .
`;
    const result = await runReconciliation([
      {
        content:
          PREFIXES +
          ccdaEncounter('urn:uuid:enc-doc-a', CSN) +
          ccdaEncounter('urn:uuid:enc-doc-b', CSN) +
          ccdaEncounter('urn:uuid:enc-doc-c', CSN) +
          edgesTo('urn:uuid:enc-doc-a', 1) +
          edgesTo('urn:uuid:enc-doc-b', 2) +
          edgesTo('urn:uuid:enc-doc-c', 3),
        systemName: 'providence-ccda',
      },
    ]);

    const subjects = encounterSubjects(result.turtle);
    expect(subjects).toHaveLength(1);
    expect(new Set(valuesOf(result.turtle, HAS_ENCOUNTER))).toEqual(new Set(subjects));
    expect(danglingEncounterEdges(result.turtle)).toEqual([]);
  });
});

describe('reconciler: --reconcile-existing converges a pod that already holds duplicates', () => {
  it('pulls the pod\'s two copies of one visit into the survivor of the new import', async () => {
    // The pod holds today's shape: two subjects, one visit. The import brings a
    // third document re-declaring the same visit. Only NEW records seed a group
    // (pod content is reconciled by `pod reconcile`, not as a side effect of an
    // unrelated import), so the seed is the new record and both pod copies are
    // candidates it absorbs.
    const pod =
      PREFIXES +
      ccdaEncounter('urn:uuid:enc-pod-a', CSN) +
      fhirEncounter('urn:uuid:enc-pod-b', CSN) +
      `<urn:uuid:note-1> a clinical:ClinicalDocument ;
  clinical:sourceEHR "Providence" ;
  clinical:hasEncounter <urn:uuid:enc-pod-a> .
<urn:uuid:note-2> a clinical:ClinicalDocument ;
  clinical:sourceEHR "Providence" ;
  clinical:hasEncounter <urn:uuid:enc-pod-b> .
`;

    const result = await runReconciliation([
      { content: pod, systemName: 'existing-pod', existingPod: true },
      { content: `${PREFIXES}${ccdaEncounter('urn:uuid:enc-new', CSN)}`, systemName: 'providence-ccda-2' },
    ]);

    const subjects = encounterSubjects(result.turtle);
    expect(subjects).toHaveLength(1);
    expect(objectsOf(result.turtle, 'urn:uuid:note-1', HAS_ENCOUNTER)).toEqual(subjects);
    expect(objectsOf(result.turtle, 'urn:uuid:note-2', HAS_ENCOUNTER)).toEqual(subjects);
    expect(danglingEncounterEdges(result.turtle)).toEqual([]);
  });

  it('is a fixed point: reconciling the merged pod again changes nothing', async () => {
    const first = await runReconciliation([
      { content: `${PREFIXES}${ccdaEncounter('urn:uuid:enc-ccda', CSN)}`, systemName: 'providence-ccda' },
      { content: `${PREFIXES}${fhirEncounter('urn:uuid:enc-fhir', CSN)}`, systemName: 'providence-fhir' },
    ]);
    const second = await runReconciliation([
      { content: first.turtle, systemName: 'existing-pod', existingPod: true },
      { content: `${PREFIXES}${fhirEncounter('urn:uuid:enc-fhir', CSN)}`, systemName: 'providence-fhir' },
    ]);
    const third = await runReconciliation([
      { content: second.turtle, systemName: 'existing-pod', existingPod: true },
      { content: `${PREFIXES}${fhirEncounter('urn:uuid:enc-fhir', CSN)}`, systemName: 'providence-fhir' },
    ]);

    expect(encounterSubjects(second.turtle)).toHaveLength(1);
    expect(second.turtle).toBe(third.turtle);
  });
});
