/**
 * The ORIGIN axis: `cascade:sourceIdentity`, and the two things that read it.
 *
 * WHAT IS BEING PROTECTED
 * -----------------------
 * A record carries three source-shaped facts — ORIGIN (`cascade:sourceIdentity`),
 * display LABEL (`clinical:sourceEHR`) and INGESTION (`cascade:sourceSystem`) —
 * and before this change the codebase had two of them and used both as if they
 * were the third. Both misuses were measured, and they fail in opposite
 * directions:
 *
 *   the reconciler's same-source guard keyed on the INGESTION label, so on a pod
 *   imported under ONE label no pair of records was ever compared (148
 *   cross-source duplicates invisible on one real corpus);
 *
 *   the two converters derived the display LABEL by different rules — endpoint
 *   domain on the FHIR path, custodian organization name on the C-CDA path — so
 *   ONE health system rendered as TWO sources on a mixed pod.
 *
 * WHAT EACH TEST WOULD DO IF THE FIX WERE ABSENT
 * ----------------------------------------------
 * Every assertion below was observed RED before the fix landed, and each one is
 * pinned to a specific line rather than to the feature in general. The mutation
 * ledger in the PR records which line each group dies on. Summarised:
 *
 *   - the normalization pairs die if the generic-word strip is removed from
 *     either the NAME path or the HOST path (the two paths must agree);
 *   - the tier tests die if the fallback order changes, or if the `transport:`
 *     prefix is dropped (which is what makes "we do not know" legible);
 *   - the converter emission tests die if either converter stops stamping, or if
 *     the FHIR path goes back to a per-resource label;
 *   - the guard tests die on either half of `sameSourceStatement`: drop the
 *     origin comparison and the shared-label pod stops reconciling, drop the
 *     transport comparison and one system's two transports stop reconciling;
 *   - the collision tests die if the mint stops consulting the id scope, and the
 *     order-independence one dies if the scope is turned into a running registry
 *     rather than a pre-scan.
 *
 * All data is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';

import { orgSlug, sourceIdentity, isKnownOrigin, SOURCE_IDENTITY_PREDICATE } from '../src/lib/source-identity.js';
import { convert } from '../src/lib/fhir-converter/index.js';
import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { runReconciliation } from '../src/lib/reconciler.js';
import { ccdaRecordUri } from '../src/lib/ccda-converter/record-identity.js';
import { deterministicUuid } from '../src/lib/fhir-converter/types.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SOURCE_SYSTEM = 'https://ns.cascadeprotocol.org/core/v1#sourceSystem';
const SOURCE_EHR = 'https://ns.cascadeprotocol.org/clinical/v1#sourceEHR';

interface Triple { s: string; p: string; o: string }

function parse(ttl: string): Triple[] {
  return new Parser({ format: 'Turtle' })
    .parse(ttl)
    .map((q) => ({ s: q.subject.value, p: q.predicate.value, o: q.object.value }));
}

/** Distinct object values of a predicate, sorted. */
function values(triples: Triple[], predicate: string): string[] {
  return [...new Set(triples.filter((t) => t.p === predicate).map((t) => t.o))].sort();
}

/** Record subjects (those carrying an rdf:type). */
function recordSubjects(triples: Triple[]): string[] {
  return [...new Set(triples.filter((t) => t.p === RDF_TYPE).map((t) => t.s))].sort();
}

// ---------------------------------------------------------------------------
// The normalization
// ---------------------------------------------------------------------------

describe('orgSlug: one organization, one slug, whichever way the document names it', () => {
  // The whole point of the algorithm: a NAME and a HOST for one organization
  // must land on the same token, because that is the only reason a C-CDA
  // custodian and a FHIR endpoint of one system can be recognised as one source.
  it.each([
    ['Meridian Health System', 'meridianhealth.example', 'meridian'],
    ['Meridian Health System', 'fhir.meridianhealth.example', 'meridian'],
    ['Stonebridge Hospital', 'fhir.stonebridgehospital.example', 'stonebridge'],
    ['Larkfield Clinic', 'fhir.larkfieldclinic.example', 'larkfield'],
    // The real-world pair the ruling was written from: an endpoint domain of
    // "providence.org" against a custodian of "Providence Health and Services
    // Washington and Montana". The regional qualifiers must not split the system.
    ['Providence Health and Services Washington and Montana', 'providence.org', 'providence'],
  ])('%s and %s both give %s', (name, host, slug) => {
    expect(orgSlug(name)).toBe(slug);
    expect(orgSlug(host)).toBe(slug);
  });

  it('is case, punctuation and accent insensitive', () => {
    expect(orgSlug('MERIDIAN HEALTH SYSTEM')).toBe('meridian');
    expect(orgSlug('Meridian Health System, Inc.')).toBe('meridian');
    expect(orgSlug('Méridian Health System')).toBe('meridian');
  });

  it('keeps two genuinely different organizations apart', () => {
    expect(orgSlug('fhir.stonebridgehospital.example')).not.toBe(orgSlug('fhir.larkfieldclinic.example'));
  });

  it('returns undefined rather than minting an identity out of an absence', () => {
    // "unknown" is the ratified data-absent token the C-CDA path writes when the
    // custodian named nobody. Slugging it would file every unattributed record on
    // a pod under one organization called "unknown", which is the exact failure
    // the axis exists to prevent, wearing a new name.
    expect(orgSlug('unknown')).toBeUndefined();
    expect(orgSlug('')).toBeUndefined();
    expect(orgSlug('   ')).toBeUndefined();
    expect(orgSlug(undefined)).toBeUndefined();
  });

  it('never strips a short registrable name to nothing', () => {
    // "care" is a generic word and "kp" is only two characters; stripping to
    // fewer than three would produce an identity that collides with everything.
    expect(orgSlug('kp.org')).toBe('kp');
    expect(orgSlug('healthcare.example')).toBeTruthy();
  });

  it('falls back to the whole normalized name when every token is generic', () => {
    // "Regional Medical Center" names no one in particular, but a stable
    // low-information identity beats filing it under "origin unknown".
    expect(orgSlug('Regional Medical Center')).toBe('regionalmedicalcenter');
  });
});

// ---------------------------------------------------------------------------
// The tier cascade
// ---------------------------------------------------------------------------

describe('sourceIdentity: the fallback chain, and the prefix that keeps it honest', () => {
  it('prefers an organization, from either a name or a host', () => {
    expect(sourceIdentity({ organizationName: 'Meridian Health System', endpointHost: 'other.example', transportLabel: 'batch' }))
      .toEqual({ value: 'org:meridian', tier: 'organization' });
    expect(sourceIdentity({ endpointHost: 'fhir.meridianhealth.example', transportLabel: 'batch' }))
      .toEqual({ value: 'org:meridian', tier: 'organization' });
  });

  it('falls back to the identifier namespace before the transport label', () => {
    expect(sourceIdentity({ idNamespace: '2.16.840.1.113883.19.5.99992.1', transportLabel: 'Household export' }))
      .toEqual({ value: 'ns:2.16.840.1.113883.19.5.99992.1', tier: 'namespace' });
  });

  it('reaches the transport label only last, and says so in the value', () => {
    // The prefix is load-bearing. An unprefixed batch label in the origin axis
    // is indistinguishable from a real organization, and core v3.5's
    // SourceIdentityShape rejects the unprefixed spelling for that reason.
    expect(sourceIdentity({ transportLabel: 'Household export' }))
      .toEqual({ value: 'transport:Household export', tier: 'transport' });
  });

  it('returns undefined when there is nothing at all to say', () => {
    expect(sourceIdentity({})).toBeUndefined();
  });

  it('treats only org: and ns: as a known origin', () => {
    // This is what stops the guard reading two records that share a batch label
    // and know nothing else as two records that share a source.
    expect(isKnownOrigin('org:meridian')).toBe(true);
    expect(isKnownOrigin('ns:2.16.840.1.113883.19.5.1')).toBe(true);
    expect(isKnownOrigin('transport:Household export')).toBe(false);
    expect(isKnownOrigin(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Converter emission
// ---------------------------------------------------------------------------

const MERIDIAN_FHIR = JSON.stringify({
  resourceType: 'Bundle',
  type: 'collection',
  entry: [
    {
      resource: {
        resourceType: 'Condition',
        id: 'cond-1',
        code: { coding: [{ system: 'http://snomed.info/sct', code: '44054006', display: 'Type 2 diabetes mellitus' }] },
        subject: { reference: 'https://fhir.meridianhealth.example/api/FHIR/R4/Patient/pt-1' },
        // Only THIS resource names the organization. Before the bundle-level
        // derivation, that alone produced two labels inside one export.
        recorder: { display: 'Meridian Health System' },
      },
    },
    {
      resource: {
        resourceType: 'Observation',
        id: 'obs-1',
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c' }], text: 'Hemoglobin A1c' },
        subject: { reference: 'https://fhir.meridianhealth.example/api/FHIR/R4/Patient/pt-1' },
        effectiveDateTime: '2031-02-11T09:15:00-08:00',
        valueQuantity: { value: 7.4, unit: '%' },
      },
    },
  ],
});

const MERIDIAN_CCDA = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.19.5.90001.1" extension="SYN-CCDA-001"/>
  <code code="34133-9" displayName="Summarization of Episode Note" codeSystem="2.16.840.1.113883.6.1"/>
  <effectiveTime value="20310214081500-0800"/>
  <recordTarget><patientRole>
    <id root="2.16.840.1.113883.19.5.90001.2" extension="MRN-1"/>
    <patient>
      <name use="L"><given>Marisol</given><family>Quintaine</family></name>
      <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/>
      <birthTime value="19710418"/>
    </patient>
  </patientRole></recordTarget>
  <custodian><assignedCustodian><representedCustodianOrganization>
    <id root="2.16.840.1.113883.19.5.90001.1"/>
    <name>Meridian Health System</name>
  </representedCustodianOrganization></assignedCustodian></custodian>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
    <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Results</title>
    <text>Hemoglobin A1c 7.4 %</text>
    <entry typeCode="DRIV"><organizer classCode="BATTERY" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.1"/>
      <id root="2.16.840.1.113883.19.5.90001.4" extension="SYN-ORG-A1C"/>
      <code code="24323-8" displayName="Comprehensive metabolic panel" codeSystem="2.16.840.1.113883.6.1"/>
      <effectiveTime value="20310211091500-0800"/>
      <component><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
        <id root="2.16.840.1.113883.19.5.90001.5" extension="SYN-OBS-A1C"/>
        <code code="4548-4" displayName="Hemoglobin A1c" codeSystem="2.16.840.1.113883.6.1"/>
        <effectiveTime value="20310211091500-0800"/>
        <value xsi:type="PQ" value="7.4" unit="%"/>
      </observation></component>
    </organizer></entry>
  </section></structuredBody></component>
</ClinicalDocument>`;

describe('converter emission: both transports mint the identity at one chokepoint', () => {
  it('stamps ONE origin on every record of a FHIR bundle', async () => {
    const result = await convert(MERIDIAN_FHIR, 'fhir', 'cascade', 'turtle', 'meridian-fhir-export');
    const triples = parse(result.output);
    expect(values(triples, SOURCE_IDENTITY_PREDICATE)).toEqual(['org:meridian']);
    // Every record, not just the one that named the organization.
    const stamped = new Set(triples.filter((t) => t.p === SOURCE_IDENTITY_PREDICATE).map((t) => t.s));
    for (const subject of recordSubjects(triples)) expect(stamped.has(subject)).toBe(true);
  });

  it('stamps ONE origin on every record of a C-CDA document', async () => {
    const result = await convertCcda(MERIDIAN_CCDA, { sourceSystem: 'meridian-ccda-summary' });
    const triples = parse(result.output);
    expect(values(triples, SOURCE_IDENTITY_PREDICATE)).toEqual(['org:meridian']);
    const stamped = new Set(triples.filter((t) => t.p === SOURCE_IDENTITY_PREDICATE).map((t) => t.s));
    for (const subject of recordSubjects(triples)) expect(stamped.has(subject)).toBe(true);
  });

  it('gives one health system ONE origin across both transports', async () => {
    // The invariant. Two transports, two different derivation inputs (an endpoint
    // host and a custodian organization name), one identity.
    const fhir = parse((await convert(MERIDIAN_FHIR, 'fhir', 'cascade', 'turtle', 'meridian-fhir-export')).output);
    const ccda = parse((await convertCcda(MERIDIAN_CCDA, { sourceSystem: 'meridian-ccda-summary' })).output);
    const combined = [...values(fhir, SOURCE_IDENTITY_PREDICATE), ...values(ccda, SOURCE_IDENTITY_PREDICATE)];
    expect(new Set(combined).size).toBe(1);
  });

  it('gives one health system ONE display label across both transports', async () => {
    // The LABEL axis keeps its semantics — it is still what the source called the
    // organization — but the FHIR path now prefers a stated organization NAME over
    // the endpoint domain, which is the rule the C-CDA path already used. Without
    // that, one system reads as "meridianhealth.example" and "Meridian Health
    // System" on one pod.
    const fhir = parse((await convert(MERIDIAN_FHIR, 'fhir', 'cascade', 'turtle', 'meridian-fhir-export')).output);
    const ccda = parse((await convertCcda(MERIDIAN_CCDA, { sourceSystem: 'meridian-ccda-summary' })).output);
    expect(values(fhir, SOURCE_EHR)).toEqual(['Meridian Health System']);
    expect(values(ccda, SOURCE_EHR)).toEqual(['Meridian Health System']);
  });

  it('falls to the ns tier when a C-CDA custodian names nobody', async () => {
    // A real vendor shape: the custodian element is present and carries an OID
    // root but no <name>. There is no organization to normalize, and the OID root
    // is a real fact about where the record's identifiers were assigned, so it is
    // a better answer than the import-batch label — which is why the chain has
    // three tiers and not two.
    const nameless = MERIDIAN_CCDA.replace('<name>Meridian Health System</name>', '');
    const triples = parse((await convertCcda(nameless, { sourceSystem: 'anonymous-batch' })).output);
    expect(values(triples, SOURCE_IDENTITY_PREDICATE)).toEqual(['ns:2.16.840.1.113883.19.5.90001.1']);
    // And the display label is still the ratified data-absent token, not the OID
    // and not the batch name: the two axes answer different questions.
    expect(values(triples, SOURCE_EHR)).toEqual(['unknown']);
  });

  it('keeps the ORIGIN and the INGESTION axes separate', async () => {
    // Two exports of one system under two batch labels: same origin, different
    // ingestion. Neither value may leak into the other's predicate.
    const fhir = parse((await convert(MERIDIAN_FHIR, 'fhir', 'cascade', 'turtle', 'meridian-fhir-export')).output);
    expect(values(fhir, SOURCE_SYSTEM)).toEqual(['meridian-fhir-export']);
    expect(values(fhir, SOURCE_IDENTITY_PREDICATE)).toEqual(['org:meridian']);
  });

  it('falls to the transport tier, prefixed, when a bundle names and locates nobody', async () => {
    // Every reference a urn:uuid, no Organization, no institution display: the
    // producer must say it does not know rather than inventing an origin.
    const anonymous = JSON.stringify({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{
        resource: {
          resourceType: 'Observation',
          id: 'obs-anon',
          status: 'final',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '1751-7' }], text: 'Albumin' },
          subject: { reference: 'urn:uuid:5c1de001-0000-4000-8000-0000000000ff' },
          effectiveDateTime: '2031-05-20T06:12:00-07:00',
          valueQuantity: { value: 4.1, unit: 'g/dL' },
        },
      }],
    });
    const triples = parse((await convert(anonymous, 'fhir', 'cascade', 'turtle', 'Household export')).output);
    expect(values(triples, SOURCE_IDENTITY_PREDICATE)).toEqual(['transport:Household export']);
  });
});

// ---------------------------------------------------------------------------
// The same-source guard
// ---------------------------------------------------------------------------

const RECON_PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
`;

/** One lab record, parameterised on the two source axes. */
function labTtl(uri: string, opts: { batch: string; origin?: string; value?: string }): string {
  const origin = opts.origin ? `  cascade:sourceIdentity "${opts.origin}" ;\n` : '';
  return `${RECON_PREFIXES}
<${uri}> a health:LabResultRecord ;
  cascade:sourceSystem "${opts.batch}" ;
${origin}  health:testCode <http://loinc.org/rdf#2951-2> ;
  health:testName "Sodium" ;
  health:performedDate "2031-05-20" ;
  health:resultValue "${opts.value ?? '141'}" .
`;
}

/** Merged pairs the reconciler produced, as a count of records that survived. */
async function survivingRecords(a: string, b: string, systemA: string, systemB: string): Promise<number> {
  const result = await runReconciliation([
    { content: a, systemName: systemA },
    { content: b, systemName: systemB },
  ]);
  return recordSubjects(parse(result.turtle)).length;
}

describe('the same-source guard reads the ORIGIN, not the transport', () => {
  it('compares two organizations that share ONE import-batch label', async () => {
    // The P07-SHARED-LABEL shape at unit scale, and the defect this change
    // exists for: keyed on the batch label alone these are "same source" and
    // never compared, so the duplicate survives.
    const alpha = labTtl('urn:uuid:lab-alpha', { batch: 'Household export', origin: 'org:stonebridge' });
    const beta = labTtl('urn:uuid:lab-beta', { batch: 'Household export', origin: 'org:larkfield' });
    expect(await survivingRecords(alpha, beta, 'Household export', 'Household export')).toBe(1);
  });

  it('still refuses to compare one organization\'s own two records in one batch', async () => {
    // The guard's real job. Two readings the same organization stated separately
    // in one export are two facts, and a matcher let loose on them destroys one.
    const first = labTtl('urn:uuid:lab-first', { batch: 'Household export', origin: 'org:stonebridge' });
    const second = labTtl('urn:uuid:lab-second', { batch: 'Household export', origin: 'org:stonebridge' });
    expect(await survivingRecords(first, second, 'Household export', 'Household export')).toBe(2);
  });

  it('compares one organization\'s two DIFFERENT ingestions', async () => {
    // One system exporting FHIR and a C-CDA is the re-sync case reconciliation
    // exists for. An origin-only guard would suppress this, and corpus scenario
    // P01 would fall from 2 merges to 0.
    const fhirSide = labTtl('urn:uuid:lab-fhir', { batch: 'meridian-fhir-export', origin: 'org:meridian' });
    const ccdaSide = labTtl('urn:uuid:lab-ccda', { batch: 'meridian-ccda-summary', origin: 'org:meridian' });
    expect(await survivingRecords(fhirSide, ccdaSide, 'meridian-fhir-export', 'meridian-ccda-summary')).toBe(1);
  });

  it('falls back to the batch label for records that carry no origin', async () => {
    // A pod written before core v3.5. The guard must behave exactly as it did,
    // which means suppressing MORE comparison, not less: duplicates left in the
    // pod are recoverable, a wrong merge is not.
    const first = labTtl('urn:uuid:lab-legacy-1', { batch: 'Household export' });
    const second = labTtl('urn:uuid:lab-legacy-2', { batch: 'Household export' });
    expect(await survivingRecords(first, second, 'Household export', 'Household export')).toBe(2);
  });

  it('treats two transport-tier origins as unknown rather than as a shared source', async () => {
    // Both records honestly said "I do not know where this came from". That is
    // not evidence that they came from the same place, and it is not evidence
    // that they came from different places either, so the conservative reading
    // wins and they are not compared.
    const first = labTtl('urn:uuid:lab-anon-1', { batch: 'Household export', origin: 'transport:Household export' });
    const second = labTtl('urn:uuid:lab-anon-2', { batch: 'Household export', origin: 'transport:Household export' });
    expect(await survivingRecords(first, second, 'Household export', 'Household export')).toBe(2);
  });

  it('records that the fast path never compares two NEW records with each other, whatever the guard says', async () => {
    // MEASURED, twice, and pinned so the day either half changes is visible.
    //
    // `runReconciliation` has two matching paths and picks the
    // `--reconcile-existing` fast path when an input is marked
    // `existingPod: true` (the flag the cross-batch sweep introduced; the old
    // `systemName` convention was overwritten by every pod record's own triple
    // and never selected it). On that path, the cross-batch pass assigns EVERY
    // new record — matched or not — before the new-against-new pass runs, so
    // that pass's guard site is unreachable and two duplicates arriving in ONE
    // import are never compared with each other, whatever the same-source guard
    // would have said about them. That is a property of the pass ordering, not
    // of the origin axis, and it is pinned here rather than fixed here.
    //
    // The second half is the contrast that shows what is at stake: the SAME two
    // records through the single-batch path DO merge, because the guard reads
    // their two different known origins under the shared batch label and admits
    // the comparison (the P07-SHARED-LABEL semantics). The fast path and the
    // single-batch path disagreeing about a batch's internal duplicates is a
    // real gap, and it is tracked; this test is the measurement.
    const pod = `${RECON_PREFIXES}
<urn:uuid:lab-already-in-pod> a health:LabResultRecord ;
  health:testCode <http://loinc.org/rdf#2160-0> ;
  health:testName "Creatinine" ;
  health:performedDate "2031-05-20" ;
  health:resultValue "1.1" .
`;
    const alpha = labTtl('urn:uuid:lab-alpha-x', { batch: 'Household export', origin: 'org:stonebridge' });
    const beta = labTtl('urn:uuid:lab-beta-x', { batch: 'Household export', origin: 'org:larkfield' });

    // Fast path: pod content present. The duplicate pair survives un-compared.
    const fast = await runReconciliation([
      { content: pod, systemName: 'existing-pod', existingPod: true },
      { content: alpha, systemName: 'Household export' },
      { content: beta, systemName: 'Household export' },
    ]);
    expect(recordSubjects(parse(fast.turtle)).length).toBe(3);

    // Single-batch path: same pair, no pod content. The guard admits, they merge.
    const single = await runReconciliation([
      { content: alpha, systemName: 'Household export' },
      { content: beta, systemName: 'Household export' },
    ]);
    expect(recordSubjects(parse(single.turtle)).length).toBe(1);
  });

  it('does not treat an origin difference on one IRI as an identity collision', async () => {
    // Two arrivals of ONE subject IRI that differ only on the origin axis are one
    // record retrieved twice, not two records fighting over an identity. If the
    // origin counted as collision evidence, every re-import of a record whose
    // origin derivation improved would split into two.
    const uri = 'urn:uuid:lab-one-iri';
    const first = labTtl(uri, { batch: 'batch-1', origin: 'org:stonebridge' });
    const second = labTtl(uri, { batch: 'batch-2', origin: 'org:larkfield' });
    const result = await runReconciliation([
      { content: first, systemName: 'batch-1' },
      { content: second, systemName: 'batch-2' },
    ]);
    expect(result.report.summary.identityCollisionsSplit).toBe(0);
    expect(recordSubjects(parse(result.turtle)).length).toBe(1);
  });

  it('never fills a missing origin in from the record it merged away', async () => {
    // A winner that carries no origin HAS no origin. Inheriting the loser's would
    // attribute the surviving record to an organization it never came from, which
    // is worse than the absence it replaces because it is not visible as a guess.
    //
    // The values differ inside lab tolerance ON PURPOSE: property fill-in happens
    // only on the merge_values path, and merge_values runs only for NEAR
    // duplicates. Two byte-identical labs resolve by trust alone and never reach
    // the line this test pins.
    const winner = labTtl('urn:uuid:lab-no-origin', { batch: 'batch-1' });
    const loser = labTtl('urn:uuid:lab-with-origin', { batch: 'batch-2', origin: 'org:larkfield', value: '141.2' });
    const result = await runReconciliation(
      [
        { content: winner, systemName: 'batch-1' },
        { content: loser, systemName: 'batch-2' },
      ],
      { trustScores: { 'batch-1': 0.95, 'batch-2': 0.60 } },
    );
    const triples = parse(result.turtle);
    expect(recordSubjects(triples).length).toBe(1);
    expect(values(triples, SOURCE_IDENTITY_PREDICATE)).toEqual([]);
  });

  it('does not raise a conflict on the origin difference it just admitted', async () => {
    // Two copies of one result from two organizations differ on the origin axis
    // by construction. If that difference also counted as an identity collision,
    // every cross-source duplicate would raise a conflict.
    const alpha = labTtl('urn:uuid:lab-alpha-c', { batch: 'Household export', origin: 'org:stonebridge' });
    const beta = labTtl('urn:uuid:lab-beta-c', { batch: 'Household export', origin: 'org:larkfield' });
    const result = await runReconciliation([
      { content: alpha, systemName: 'Household export' },
      { content: beta, systemName: 'Household export' },
    ]);
    expect(result.report.summary.conflictsUnresolved).toBe(0);
    expect(result.report.summary.identityCollisionsSplit).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The id-collision disambiguator
// ---------------------------------------------------------------------------

/** A C-CDA results section whose observations are supplied as raw XML. */
function ccdaWithObservations(observations: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.19.5.90002.1" extension="SYN-CCDA-002"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1"/>
  <effectiveTime value="20310406101000-0500"/>
  <recordTarget><patientRole>
    <id root="2.16.840.1.113883.19.5.90002.2" extension="MRN-2"/>
    <patient>
      <name use="L"><given>Teodoro</given><family>Halvane</family></name>
      <administrativeGenderCode code="M" codeSystem="2.16.840.1.113883.5.1"/>
      <birthTime value="19580922"/>
    </patient>
  </patientRole></recordTarget>
  <custodian><assignedCustodian><representedCustodianOrganization>
    <id root="2.16.840.1.113883.19.5.90002.1"/>
    <name>Northgate Regional Laboratory</name>
  </representedCustodianOrganization></assignedCustodian></custodian>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
    <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Results</title>
    <text>Basic metabolic panel</text>
    <entry typeCode="DRIV"><organizer classCode="BATTERY" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.1"/>
      <id root="2.16.840.1.113883.19.5.90002.4" extension="SYN-ORG-BMP"/>
      <code code="51990-0" codeSystem="2.16.840.1.113883.6.1"/>
      <effectiveTime value="20310406094500-0500"/>
      ${observations.map((o) => `<component>${o}</component>`).join('\n      ')}
    </organizer></entry>
  </section></structuredBody></component>
</ClinicalDocument>`;
}

/** One observation sharing the SHARED_ID root-only identifier. */
function sharedIdObservation(code: string, name: string, value: string, unit: string): string {
  return `<observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
        <id root="a1d84b70-5c31-11ef-9c1d-0800200c9a66"/>
        <code code="${code}" displayName="${name}" codeSystem="2.16.840.1.113883.6.1"/>
        <effectiveTime value="20310406094500-0500"/>
        <value xsi:type="PQ" value="${value}" unit="${unit}"/>
      </observation>`;
}

const LAB_RECORD_TYPE = 'https://ns.cascadeprotocol.org/health/v1#LabResultRecord';

/** Subject IRIs of the lab records a C-CDA converted to, sorted. */
async function labSubjects(xml: string): Promise<string[]> {
  const triples = parse((await convertCcda(xml, { sourceSystem: 'synthetic' })).output);
  return triples.filter((t) => t.p === RDF_TYPE && t.o === LAB_RECORD_TYPE).map((t) => t.s).sort();
}

describe('a source id contradicted by the source\'s own content stops identifying', () => {
  const sodium = sharedIdObservation('2951-2', 'Sodium', '139', 'mmol/L');
  const potassium = sharedIdObservation('2823-3', 'Potassium', '4.2', 'mmol/L');
  const chloride = sharedIdObservation('2075-0', 'Chloride', '104', 'mmol/L');

  it('mints one subject per contradicting claimant', async () => {
    // Three results that disagree about their code, name, value and unit share one
    // root-only <id>, which is the shape the public HL7 CCD sample distributes.
    // Believing the id outright folds them onto one subject and silently loses two
    // results; the only trace on `main` is two SHACL maxCount violations.
    const subjects = await labSubjects(ccdaWithObservations([sodium, potassium, chloride]));
    expect(subjects.length).toBe(3);
    expect(new Set(subjects).size).toBe(3);
  });

  it('still folds content-identical restatements of one id onto one subject', async () => {
    // Two entries with one id and identical content are one act stated twice.
    // Splitting them would recreate the duplicate-on-every-import defect.
    const subjects = await labSubjects(ccdaWithObservations([sodium, sodium]));
    expect(subjects.length).toBe(1);
  });

  it('splits on TWO contradicting claimants, not only on three', async () => {
    // The threshold is "more than one distinct content fingerprint under one id".
    // A test written only against the three-way collision in the corpus fixture
    // leaves "> 1" and "> 2" indistinguishable, and the two-way case is the more
    // common one in real exports.
    const subjects = await labSubjects(ccdaWithObservations([sodium, potassium]));
    expect(subjects.length).toBe(2);
  });

  it('does not disturb an observation whose id is its own', async () => {
    // The control. Whatever happens to the colliding entries must not happen to a
    // properly identified one, and its IRI must not move.
    const distinct = `<observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
        <id root="2.16.840.1.113883.19.5.90002.5" extension="SYN-OBS-CREAT"/>
        <code code="2160-0" displayName="Creatinine" codeSystem="2.16.840.1.113883.6.1"/>
        <effectiveTime value="20310406094500-0500"/>
        <value xsi:type="PQ" value="1.1" unit="mg/dL"/>
      </observation>`;
    const alone = await labSubjects(ccdaWithObservations([distinct]));
    const alongside = await labSubjects(ccdaWithObservations([sodium, potassium, chloride, distinct]));
    expect(alone.length).toBe(1);
    expect(alongside.length).toBe(4);
    // The uncontradicted record's IRI is identical whether or not a collision
    // happened elsewhere in the document.
    expect(alongside).toContain(alone[0]);
  });

  it('is independent of the order the contradicting entries appear in', async () => {
    // The determinism property, and the reason the scope is a PRE-SCAN rather
    // than a registry that disambiguates the second and later claimants: under a
    // running registry the first entry keeps the bare id, so reordering the
    // document moves two of the three IRIs.
    const forward = await labSubjects(ccdaWithObservations([sodium, potassium, chloride]));
    const reversed = await labSubjects(ccdaWithObservations([chloride, potassium, sodium]));
    expect(reversed).toEqual(forward);
  });

  it('mints the same subjects on a second conversion of the same document', async () => {
    const xml = ccdaWithObservations([sodium, potassium, chloride]);
    expect(await labSubjects(xml)).toEqual(await labSubjects(xml));
  });

  it('closes the scope when the document is done, so nothing minted later inherits it', async () => {
    // The scope is module state. `beginCcdaIdScope` resets it, so a leak is
    // invisible between two CONVERSIONS — which is exactly why this asserts on a
    // mint OUTSIDE one. Without the `finally { endCcdaIdScope() }` the previous
    // document's contradicted ids stay live for every later caller of the door,
    // and this record's IRI moves.
    //
    // The expectation is computed from the key template rather than from a mint
    // taken before the conversion: this file converts colliding documents in
    // several tests, so a "before" value would ALREADY carry a leaked scope and
    // the comparison would hold for the wrong reason.
    const sharedId = 'a1d84b70-5c31-11ef-9c1d-0800200c9a66';
    await labSubjects(ccdaWithObservations([sodium, potassium, chloride]));
    const minted = ccdaRecordUri({
      type: 'LabResult',
      sourceId: sharedId,
      content: {},
      source: { code: { '@_code': '2951-2' }, value: { '@_value': '139' } },
    });
    expect(minted).toBe(`urn:uuid:${deterministicUuid(`LabResult:${sharedId}`)}`);
  });
});
