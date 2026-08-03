/**
 * Every importer must mint the SAME IRI for the same id-less record, forever.
 *
 * FHIR makes `Resource.id` optional and real payloads exercise that: a
 * transaction Bundle POSTing new resources omits it, contained resources omit
 * it, hand-authored and exported documents omit it. Every importer here used to
 * answer that case with `randomUUID()` or `Math.random()` — or, in two places,
 * with `ctx.importedAt`, a per-run timestamp, which is randomness with extra
 * steps. Re-importing one document therefore minted a second identity for every
 * record in it, so nothing ever reconciled and the pod grew a duplicate set on
 * every sync. Silently: a fresh IRI is indistinguishable from a new record.
 *
 * These tests pin BOTH halves of the fix, because either alone is worthless:
 *
 *   DETERMINISM  — same content in, same IRI out. Across runs, across bundle
 *                  positions, across `importedAt` values.
 *   DISTINCTNESS — different content in, different IRI out. A function that
 *                  returns a constant satisfies determinism perfectly and is
 *                  useless; only the pair is the fix.
 *
 * Cross-PROCESS stability lives in `identity-cross-process.test.ts`. Minting
 * twice inside one process can pass on a warm module cache, so it proves less
 * than it looks like it does.
 *
 * Every fixture below is synthetic and PHI-free, and none of them carry an
 * `id` — which is exactly why the pre-existing suites never saw this.
 */

import { describe, it, expect } from 'vitest';

import { convertFhirResourceToQuads } from '../src/lib/fhir-converter/fhir-to-cascade.js';
import { convertGenomicsBundle } from '../src/lib/fhir-genomics-converter/index.js';
import { convertPhenopacket } from '../src/lib/phenopacket-converter/index.js';
import { convertCcda } from '../src/lib/ccda-converter/index.js';
import type { ImportContext } from '../src/lib/import-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(importedAt = '2026-01-01T00:00:00Z'): ImportContext {
  return {
    inputPath: '/synthetic/input.json',
    outputSerialization: 'turtle',
    importedAt,
    options: {},
  };
}

/** Deep clone, so no test can accidentally share object identity with another. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Every `urn:uuid:` IRI in a turtle string / quad list, in order. */
function urisIn(text: string): string[] {
  return text.match(/urn:uuid:[0-9a-f-]{36}/g) ?? [];
}

/**
 * The minted subject IRI of a single-resource conversion.
 *
 * `ConversionResult` carries no `uri` field, and the per-resource path leaves
 * `turtle` empty (only the batch path serializes), so the subject is read off
 * the first emitted quad — which is the `rdf:type` triple on the subject.
 */
function subjectOf(result: { _quads: Array<{ subject: { value: string } }> } | null): string {
  expect(result).not.toBeNull();
  expect(result!._quads.length).toBeGreaterThan(0);
  return result!._quads[0].subject.value;
}

// ---------------------------------------------------------------------------
// Fixtures — none carry an `id`
// ---------------------------------------------------------------------------

const ID_LESS_VITAL = {
  resourceType: 'Observation',
  status: 'final',
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
  code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
  subject: { reference: 'Patient/synthetic-1' },
  effectiveDateTime: '2026-01-15T09:30:00Z',
  valueQuantity: { value: 72, unit: 'beats/minute', system: 'http://unitsofmeasure.org', code: '/min' },
};

const ID_LESS_PROCEDURE = {
  resourceType: 'Procedure',
  status: 'completed',
  code: { coding: [{ system: 'http://snomed.info/sct', code: '80146002', display: 'Appendectomy' }] },
  subject: { reference: 'Patient/synthetic-1' },
  performedDateTime: '2025-06-02',
};

const ID_LESS_ENCOUNTER = {
  resourceType: 'Encounter',
  status: 'finished',
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
  subject: { reference: 'Patient/synthetic-1' },
  period: { start: '2026-01-15T09:00:00Z', end: '2026-01-15T09:45:00Z' },
};

const ID_LESS_CLAIM = {
  resourceType: 'Claim',
  status: 'active',
  type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
  use: 'claim',
  patient: { reference: 'Patient/synthetic-1' },
  created: '2026-01-20',
  total: { value: 240.0, currency: 'USD' },
};

const ID_LESS_COVERAGE = {
  resourceType: 'Coverage',
  status: 'active',
  beneficiary: { reference: 'Patient/synthetic-1' },
  payor: [{ display: 'Synthetic Health Plan' }],
  period: { start: '2026-01-01' },
};

const ID_LESS_DEVICE = {
  resourceType: 'Device',
  status: 'active',
  type: { coding: [{ system: 'http://snomed.info/sct', code: '706767009', display: 'Blood pressure monitor' }] },
  patient: { reference: 'Patient/synthetic-1' },
};

const ID_LESS_PASSTHROUGH = {
  resourceType: 'NutritionOrder',
  status: 'active',
  intent: 'order',
  patient: { reference: 'Patient/synthetic-1' },
  dateTime: '2026-01-15',
};

/** A FHIR Genomics Bundle whose every entry omits `id`. */
function genomicsBundle(): any {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Observation',
          meta: { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/variant'] },
          status: 'final',
          category: [{ coding: [{ code: 'laboratory' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '69548-6', display: 'Genetic variant assessment' }] },
          valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: 'LA9633-4', display: 'Present' }] },
          component: [
            {
              code: { coding: [{ system: 'http://loinc.org', code: '48004-6' }] },
              valueCodeableConcept: { text: 'NM_007294.4:c.5266dupC' },
            },
            {
              code: { coding: [{ system: 'http://loinc.org', code: '48018-6' }] },
              valueCodeableConcept: { coding: [{ system: 'http://www.genenames.org', code: 'HGNC:1100', display: 'BRCA1' }] },
            },
          ],
        },
      },
      {
        resource: {
          resourceType: 'Observation',
          meta: { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/genotype'] },
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '84413-4' }] },
          valueCodeableConcept: { text: 'CYP2C19 *1/*2' },
        },
      },
      {
        resource: {
          resourceType: 'Observation',
          meta: { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/haplotype'] },
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '84414-2' }] },
          valueCodeableConcept: { coding: [{ display: 'CYP2C19*2' }] },
        },
      },
      {
        resource: {
          resourceType: 'ServiceRequest',
          meta: { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/genomics-service-request'] },
          status: 'completed',
          intent: 'order',
          code: { coding: [{ system: 'http://loinc.org', code: '81247-9' }] },
        },
      },
      {
        resource: {
          resourceType: 'DiagnosticReport',
          meta: { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/genomics-report'] },
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '81247-9' }] },
          effectiveDateTime: '2026-01-10',
        },
      },
      {
        resource: {
          resourceType: 'Observation',
          meta: { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/diagnostic-implication'] },
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '51969-4' }] },
          component: [
            {
              code: { coding: [{ system: 'http://loinc.org', code: '53037-8' }] },
              valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: 'LA6668-3', display: 'Pathogenic' }] },
            },
            {
              code: { coding: [{ system: 'http://loinc.org', code: '81259-4' }] },
              valueCodeableConcept: { coding: [{ system: 'http://purl.obolibrary.org/obo/mondo.owl', code: 'MONDO:0007254' }] },
            },
          ],
        },
      },
    ],
  };
}

/** A phenopacket whose subject and biosample both omit `id`. */
function phenopacket(): any {
  return {
    id: 'synthetic-phenopacket-1',
    subject: {
      sex: 'FEMALE',
      timeAtLastEncounter: { age: { iso8601duration: 'P42Y' } },
    },
    biosamples: [
      {
        sampledTissue: { id: 'UBERON:0000178', label: 'blood' },
        taxonomy: { id: 'NCBITaxon:9606', label: 'Homo sapiens' },
        timeOfCollection: { age: { iso8601duration: 'P42Y' } },
      },
    ],
    metaData: { created: '2026-01-01T00:00:00Z', createdBy: 'synthetic', phenopacketSchemaVersion: '2.0' },
  };
}

/** A C-CDA whose ClinicalDocument carries NO <id> element at all. */
function ccdaWithoutDocumentId(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <realmCode code="US"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1" displayName="Summarization of Episode Note"/>
  <title>Synthetic Continuity of Care Document</title>
  <effectiveTime value="20260115093000"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="en-US"/>
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.19.5" extension="SYN-1"/>
      <patient>
        <name><given>Pat</given><family>Synthetic</family></name>
        <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19840301"/>
      </patient>
    </patientRole>
  </recordTarget>
  <custodian>
    <assignedCustodian>
      <representedCustodianOrganization>
        <name>Synthetic Health System</name>
      </representedCustodianOrganization>
    </assignedCustodian>
  </custodian>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
          <code code="11450-4" codeSystem="2.16.840.1.113883.6.1" displayName="Problem List"/>
          <title>Problems</title>
          <text>Hypertension, diagnosed 2019.</text>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>`;
}

// ---------------------------------------------------------------------------
// FHIR clinical path — mintSubjectUri, the most reachable one
// ---------------------------------------------------------------------------

describe('id-less FHIR clinical resources mint a stable IRI', () => {
  const cases: ReadonlyArray<{ name: string; resource: any }> = [
    { name: 'Observation (vital)', resource: ID_LESS_VITAL },
    { name: 'Procedure', resource: ID_LESS_PROCEDURE },
    { name: 'Encounter', resource: ID_LESS_ENCOUNTER },
    { name: 'Claim', resource: ID_LESS_CLAIM },
    { name: 'Coverage', resource: ID_LESS_COVERAGE },
    { name: 'Device', resource: ID_LESS_DEVICE },
    { name: 'NutritionOrder (passthrough)', resource: ID_LESS_PASSTHROUGH },
  ];

  for (const { name, resource } of cases) {
    it(`${name}: two conversions of the same content agree`, () => {
      const a = subjectOf(convertFhirResourceToQuads(clone(resource)));
      const b = subjectOf(convertFhirResourceToQuads(clone(resource)));
      expect(a).toBe(b);
      expect(a).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    });
  }

  it('different content yields different IRIs (the fix is not a constant)', () => {
    const uris = cases.map(({ resource }) => subjectOf(convertFhirResourceToQuads(clone(resource))));
    expect(new Set(uris).size).toBe(uris.length);
  });

  it('two Observations differing only in their value get different IRIs', () => {
    const lo = clone(ID_LESS_VITAL);
    const hi = clone(ID_LESS_VITAL);
    hi.valueQuantity.value = 118;
    const a = subjectOf(convertFhirResourceToQuads(lo));
    const b = subjectOf(convertFhirResourceToQuads(hi));
    expect(a).not.toBe(b);
  });

  it('source key ORDER does not perturb the IRI', () => {
    const forward = clone(ID_LESS_VITAL);
    const reversed: any = {};
    for (const k of Object.keys(forward).reverse()) reversed[k] = (forward as any)[k];
    expect(subjectOf(convertFhirResourceToQuads(reversed))).toBe(subjectOf(convertFhirResourceToQuads(forward)));
  });

  it('meta.lastUpdated / meta.versionId / meta.source do NOT move the IRI', () => {
    const bare = clone(ID_LESS_VITAL);
    const fetchedMonday: any = clone(ID_LESS_VITAL);
    fetchedMonday.meta = { lastUpdated: '2026-01-15T09:31:00.000+00:00', versionId: '1', source: 'urn:oid:1.2.3#a' };
    const fetchedFriday: any = clone(ID_LESS_VITAL);
    fetchedFriday.meta = { lastUpdated: '2026-02-02T17:04:22.881+00:00', versionId: '7', source: 'urn:oid:1.2.3#z' };

    const base = subjectOf(convertFhirResourceToQuads(bare));
    expect(subjectOf(convertFhirResourceToQuads(fetchedMonday))).toBe(base);
    expect(subjectOf(convertFhirResourceToQuads(fetchedFriday))).toBe(base);
  });

  it('a server-regenerated narrative does NOT move the IRI', () => {
    const bare = clone(ID_LESS_VITAL);
    const rendered: any = clone(ID_LESS_VITAL);
    rendered.text = { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">Heart rate 72 /min (rendered 2026-02-02T17:04:22Z)</div>' };
    const reRendered: any = clone(ID_LESS_VITAL);
    reRendered.text = { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">Heart rate 72 /min (rendered 2026-03-09T08:00:00Z)</div>' };

    const base = subjectOf(convertFhirResourceToQuads(bare));
    expect(subjectOf(convertFhirResourceToQuads(rendered))).toBe(base);
    expect(subjectOf(convertFhirResourceToQuads(reRendered))).toBe(base);
  });

  it('CodeableConcept.text IS identity — it is a string, not a Narrative', () => {
    const a = clone(ID_LESS_PROCEDURE);
    const b = clone(ID_LESS_PROCEDURE);
    a.code.text = 'Appendectomy, laparoscopic';
    b.code.text = 'Appendectomy, open';
    expect(subjectOf(convertFhirResourceToQuads(a))).not.toBe(subjectOf(convertFhirResourceToQuads(b)));
  });

  it('an id-bearing resource is unaffected by the surrounding content hash', () => {
    // The with-id path must be untouched: adding volatile fields to a resource
    // that HAS an id must not move its IRI either, because the id decides.
    const withId: any = clone(ID_LESS_VITAL);
    withId.id = 'obs-heart-rate-1';
    const withIdAndMeta: any = clone(withId);
    withIdAndMeta.meta = { lastUpdated: '2026-02-02T17:04:22.881+00:00', versionId: '9' };
    const withIdChangedValue: any = clone(withId);
    withIdChangedValue.valueQuantity.value = 118;

    const base = subjectOf(convertFhirResourceToQuads(withId));
    expect(subjectOf(convertFhirResourceToQuads(withIdAndMeta))).toBe(base);
    expect(subjectOf(convertFhirResourceToQuads(withIdChangedValue))).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Genomics path
// ---------------------------------------------------------------------------

describe('id-less FHIR Genomics resources mint stable IRIs', () => {
  it('two imports of the same bundle agree on every IRI', async () => {
    const a = await convertGenomicsBundle(genomicsBundle(), ctx());
    const b = await convertGenomicsBundle(genomicsBundle(), ctx());
    expect(a.records.length).toBeGreaterThan(0);
    expect(a.records.map((r) => r.iri)).toEqual(b.records.map((r) => r.iri));
  });

  it('ctx.importedAt does NOT participate in identity', async () => {
    const a = await convertGenomicsBundle(genomicsBundle(), ctx('2026-01-01T00:00:00Z'));
    const b = await convertGenomicsBundle(genomicsBundle(), ctx('2027-11-30T23:59:59Z'));
    expect(a.records.map((r) => r.iri)).toEqual(b.records.map((r) => r.iri));
  });

  it('every record in one bundle gets a DISTINCT IRI', async () => {
    const a = await convertGenomicsBundle(genomicsBundle(), ctx());
    const iris = a.records.map((r) => r.iri);
    expect(new Set(iris).size).toBe(iris.length);
  });

  it('bundle POSITION does not decide identity', async () => {
    const forward = genomicsBundle();
    const reversed = genomicsBundle();
    reversed.entry.reverse();
    const a = await convertGenomicsBundle(forward, ctx());
    const b = await convertGenomicsBundle(reversed, ctx());
    expect(new Set(a.records.map((r) => r.iri))).toEqual(new Set(b.records.map((r) => r.iri)));
  });

  it('a changed variant yields a changed Variant IRI', async () => {
    const original = genomicsBundle();
    const edited = genomicsBundle();
    edited.entry[0].resource.component[0].valueCodeableConcept.text = 'NM_007294.4:c.181T>G';

    const a = await convertGenomicsBundle(original, ctx());
    const b = await convertGenomicsBundle(edited, ctx());
    const variantOf = (r: { records: Array<{ iri: string; cascadeType?: string }> }) =>
      r.records.filter((x) => x.cascadeType === 'genomics:Variant').map((x) => x.iri);
    expect(variantOf(a).length).toBeGreaterThan(0);
    expect(variantOf(a)).not.toEqual(variantOf(b));
  });
});

// ---------------------------------------------------------------------------
// Phenopacket path
// ---------------------------------------------------------------------------

describe('id-less phenopacket subject and biosample mint stable IRIs', () => {
  it('two imports of the same phenopacket agree on every IRI', async () => {
    const a = await convertPhenopacket(phenopacket(), ctx());
    const b = await convertPhenopacket(phenopacket(), ctx());
    expect(a.records.length).toBeGreaterThan(0);
    expect(a.records.map((r) => r.iri)).toEqual(b.records.map((r) => r.iri));
  });

  it('ctx.importedAt does NOT participate in identity', async () => {
    const a = await convertPhenopacket(phenopacket(), ctx('2026-01-01T00:00:00Z'));
    const b = await convertPhenopacket(phenopacket(), ctx('2027-11-30T23:59:59Z'));
    expect(a.records.map((r) => r.iri)).toEqual(b.records.map((r) => r.iri));
  });

  it('a subject with no id anywhere still mints stably across importedAt', async () => {
    const anonymous = () => {
      const p = phenopacket();
      delete p.id;
      return p;
    };
    const a = await convertPhenopacket(anonymous(), ctx('2026-01-01T00:00:00Z'));
    const b = await convertPhenopacket(anonymous(), ctx('2029-06-06T06:06:06Z'));
    expect(a.records.map((r) => r.iri)).toEqual(b.records.map((r) => r.iri));
  });

  it('two different biosamples get different Specimen IRIs', async () => {
    const blood = phenopacket();
    const saliva = phenopacket();
    saliva.biosamples[0].sampledTissue = { id: 'UBERON:0001836', label: 'saliva' };
    const a = await convertPhenopacket(blood, ctx());
    const b = await convertPhenopacket(saliva, ctx());
    const specimens = (r: { records: Array<{ iri: string; cascadeType?: string }> }) =>
      r.records.filter((x) => (x.cascadeType ?? '').toLowerCase().includes('specimen')).map((x) => x.iri);
    expect(specimens(a).length).toBeGreaterThan(0);
    expect(specimens(a)).not.toEqual(specimens(b));
  });
});

// ---------------------------------------------------------------------------
// C-CDA path — a document with no <id> used to key off the import timestamp
// ---------------------------------------------------------------------------

describe('a C-CDA document with no <id> mints stable IRIs', () => {
  it('two imports at different times agree on every IRI', async () => {
    const a = await convertCcda(ccdaWithoutDocumentId(), { importedAt: '2026-01-01T00:00:00Z' });
    const b = await convertCcda(ccdaWithoutDocumentId(), { importedAt: '2027-11-30T23:59:59Z' });
    const ua = urisIn(a.output ?? '');
    const ub = urisIn(b.output ?? '');
    expect(ua.length).toBeGreaterThan(0);
    expect(new Set(ua)).toEqual(new Set(ub));
  });

  it('a DIFFERENT id-less document does not collide with the first', async () => {
    const other = ccdaWithoutDocumentId()
      .replace('<title>Synthetic Continuity of Care Document</title>', '<title>Synthetic Discharge Summary</title>')
      .replace('Hypertension, diagnosed 2019.', 'Type 2 diabetes, diagnosed 2021.');
    const a = await convertCcda(ccdaWithoutDocumentId(), { importedAt: '2026-01-01T00:00:00Z' });
    const b = await convertCcda(other, { importedAt: '2026-01-01T00:00:00Z' });
    const ua = new Set(urisIn(a.output ?? ''));
    const ub = new Set(urisIn(b.output ?? ''));
    // The two documents share a patient, so some IRIs legitimately match; the
    // ClinicalDocument nodes must not.
    expect([...ua].some((u) => !ub.has(u))).toBe(true);
  });
});
