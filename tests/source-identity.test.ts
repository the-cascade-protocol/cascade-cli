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
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  orgSlug,
  sourceIdentity,
  sourceLabel,
  isKnownOrigin,
  CANONICAL_ORGANIZATIONS,
  SOURCE_IDENTITY_PREDICATE,
} from '../src/lib/source-identity.js';
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
    // "care" is a generic word; stripping a two-character registrable name to
    // fewer than three characters would produce an identity that collides with
    // everything.
    //
    // The example used to be "kp.org", which now folds through the crosswalk and
    // so no longer measures the strip floor at all. A two-letter host that names
    // nobody in the table measures it and only it.
    expect(orgSlug('rw.example')).toBe('rw');
    expect(orgSlug('healthcare.example')).toBeTruthy();
  });

  it('falls back to the whole normalized name when every token is generic', () => {
    // "Regional Medical Center" names no one in particular, but a stable
    // low-information identity beats filing it under "origin unknown".
    expect(orgSlug('Regional Medical Center')).toBe('regionalmedicalcenter');
  });
});

// ---------------------------------------------------------------------------
// The crosswalk, and the slugs it must NOT move
// ---------------------------------------------------------------------------

describe('the crosswalk folds the pairs no string transform could', () => {
  it('resolves a host that shares no token with the organization name', () => {
    // The case that motivates a table at all. "kp.org" reduces to "kp" and
    // every document that names the system reduces to "kaiser": nothing about
    // the two strings relates them, so the normalization cannot and must not
    // guess. Measured on one real pod as an even split of one system.
    expect(orgSlug('kp.org')).toBe('kaiser');
    expect(orgSlug('Kaiser Permanente')).toBe('kaiser');
    expect(orgSlug('Kaiser Foundation Health Plan of Washington')).toBe('kaiser');
    expect(orgSlug('fhir.kp.org')).toBe('kaiser');
  });

  it('gives a crosswalked organization ONE display name from either spelling', () => {
    expect(sourceLabel(sourceIdentity({ endpointHost: 'kp.org' }))).toBe('Kaiser Permanente');
    expect(sourceLabel(sourceIdentity({ organizationName: 'Kaiser Permanente' }))).toBe(
      'Kaiser Permanente',
    );
  });

  /**
   * THE GOLDEN PINS. Inputs whose slugs must not move, ever.
   *
   * `cascade:sourceIdentity` is identity-adjacent: the tier-0 merge predicate
   * requires all origins known AND distinct, and the same-source guard keys on
   * the value. Moving the slug an input produces re-keys both for every record
   * already on a pod, so a change that looks like a normalization tidy-up is a
   * change to which records are eligible to merge with which.
   *
   * The crosswalk is the ONE sanctioned way to move one, and moving one that way
   * is a decision that shows up as an edit to this table. A slug that moves
   * without such an edit is a defect whichever direction it moved in, which is
   * what makes this pin two-sided alongside the convergence assertions above.
   */
  it.each([
    ['Meridian Health System', 'meridian'],
    ['meridianhealth.example', 'meridian'],
    ['fhir.meridianhealth.example', 'meridian'],
    ['Stonebridge Hospital', 'stonebridge'],
    ['fhir.stonebridgehospital.example', 'stonebridge'],
    ['Larkfield Clinic', 'larkfield'],
    ['fhir.larkfieldclinic.example', 'larkfield'],
    ['Providence Health and Services Washington and Montana', 'providence'],
    ['providence.org', 'providence'],
    ['Northgate Regional Laboratory', 'northgate'],
    ['haiku.swedish.org', 'swedish'],
    ['swedish.org', 'swedish'],
    ['Swedish', 'swedish'],
    ['Brightwater Medical Group', 'brightwater'],
    ['Regional Medical Center', 'regionalmedicalcenter'],
    ['rw.example', 'rw'],
  ])('golden: %s stays on %s', (input, slug) => {
    expect(orgSlug(input)).toBe(slug);
  });

  it('every alias in the crosswalk actually resolves to its canonical slug', () => {
    // A table row that names an alias the normalization never produces is dead
    // weight that reads as coverage. Each alias must be a slug some spelling
    // really reduces to, and it must not be a canonical slug itself.
    const canonical = new Set(CANONICAL_ORGANIZATIONS.map((o) => o.slug));
    for (const org of CANONICAL_ORGANIZATIONS) {
      for (const alias of org.aliases) {
        expect(canonical.has(alias), `alias "${alias}" is itself a canonical slug`).toBe(false);
        expect(orgSlug(`${alias}.example`), `alias "${alias}" does not fold`).toBe(org.slug);
      }
      expect(orgSlug(org.slug), `canonical slug "${org.slug}" does not survive itself`).toBe(org.slug);
    }
  });
});

// ---------------------------------------------------------------------------
// The label
// ---------------------------------------------------------------------------

describe('sourceLabel: the display name is computed from the origin, not restated', () => {
  it('ignores the stated wording entirely when an organization was derivable', () => {
    // THE LOAD-BEARING ASSERTION. Two documents of one system word its name
    // differently and a third states only a domain; all three must render the
    // same, which they can only do if the stated wording is not consulted.
    const stated = [
      'Providence Health and Services Washington and Montana',
      'Providence Health & Services',
      'providence.org',
    ];
    const labels = stated.map((s) =>
      sourceLabel(sourceIdentity({ organizationName: s }), s),
    );
    expect(new Set(labels).size).toBe(1);
    expect(labels[0]).toBe('Providence Health & Services');
  });

  it('renders an uncurated organization plainly rather than splitting it', () => {
    // No crosswalk row, so the label is the plain form of the slug. It is
    // coarser than "Meridian Health System", and it is the SAME coarse thing on
    // both transports, which is the trade the module documents.
    expect(sourceLabel(sourceIdentity({ organizationName: 'Meridian Health System' }))).toBe(
      'Meridian',
    );
    expect(sourceLabel(sourceIdentity({ endpointHost: 'fhir.meridianhealth.example' }))).toBe(
      'Meridian',
    );
  });

  it('passes the stated value through when no organization was derivable', () => {
    // ns: and transport: name no organization, so there is no canonical display
    // to compute and the honest answer is what the document said — which for a
    // custodian that named nobody is the ratified data-absent token.
    expect(
      sourceLabel(sourceIdentity({ idNamespace: '2.16.840.1.113883.19.5.1' }), 'unknown'),
    ).toBe('unknown');
    expect(sourceLabel(sourceIdentity({ transportLabel: 'Household export' }), 'unknown')).toBe(
      'unknown',
    );
  });

  it('says nothing rather than something empty', () => {
    expect(sourceLabel(undefined)).toBeUndefined();
    expect(sourceLabel(sourceIdentity({ transportLabel: 'Household export' }))).toBeUndefined();
    expect(sourceLabel(sourceIdentity({ transportLabel: 'Household export' }), '   ')).toBeUndefined();
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
    // The LABEL axis no longer restates what the source called the organization.
    // It is computed from the canonical ORIGIN, so the two transports cannot
    // disagree about it whatever their documents happen to say.
    //
    // The value moved here, deliberately: "Meridian Health System" was the
    // C-CDA custodian's wording, and this bundle agreed with it only because one
    // of its resources carried a matching `recorder.display`. The bundle two
    // tests below carries no such display, which is the ordinary shape, and
    // under the old rule it labelled itself from its domain instead.
    const fhir = parse((await convert(MERIDIAN_FHIR, 'fhir', 'cascade', 'turtle', 'meridian-fhir-export')).output);
    const ccda = parse((await convertCcda(MERIDIAN_CCDA, { sourceSystem: 'meridian-ccda-summary' })).output);
    expect(values(fhir, SOURCE_EHR)).toEqual(['Meridian']);
    expect(values(ccda, SOURCE_EHR)).toEqual(['Meridian']);
  });

  it('agrees with the C-CDA even when the bundle names no organization at all', async () => {
    // THE CASE THE EARLIER FIX COULD NOT REACH, and the one measured on real
    // data: a patient-facing export with no `Organization` resource and no
    // institution-looking display anywhere. There is no name in the document to
    // prefer, so a name-beats-host rule falls straight through to the host and
    // the system renders under its domain beside the C-CDA's stated name.
    //
    // Both halves are asserted. The FHIR half alone would pass on a converter
    // that simply stopped emitting a label.
    const stripped = JSON.parse(MERIDIAN_FHIR);
    for (const e of stripped.entry) delete e.resource.recorder;
    const hostOnly = JSON.stringify(stripped);

    const fhir = parse((await convert(hostOnly, 'fhir', 'cascade', 'turtle', 'meridian-fhir-export')).output);
    const ccda = parse((await convertCcda(MERIDIAN_CCDA, { sourceSystem: 'meridian-ccda-summary' })).output);
    expect(values(fhir, SOURCE_IDENTITY_PREDICATE)).toEqual(['org:meridian']);
    expect(values(fhir, SOURCE_EHR)).toEqual(['Meridian']);
    expect(values(ccda, SOURCE_EHR)).toEqual(['Meridian']);
    expect(new Set([...values(fhir, SOURCE_EHR), ...values(ccda, SOURCE_EHR)]).size).toBe(1);
  });

  it('gives the container-supplied account name the same label as the document', async () => {
    // The third spelling of one organization: an Apple-style container names the
    // account, and its wording is a third variant again. It sets the ORIGIN, and
    // the label follows from the origin like every other spelling does.
    const withOverride = await convert(
      MERIDIAN_FHIR, 'fhir', 'cascade', 'turtle', 'meridian-fhir-export', false,
      'Meridian Health System of the Northwest',
    );
    const ccda = parse((await convertCcda(MERIDIAN_CCDA, { sourceSystem: 'meridian-ccda-summary' })).output);
    expect(values(parse(withOverride.output), SOURCE_EHR)).toEqual(values(ccda, SOURCE_EHR));
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
// Record identity
// ---------------------------------------------------------------------------

/**
 * THE NEGATIVE CLAIM, and the one that actually had to be proved before this
 * change could ship: moving the source axes moved NO record identity.
 *
 * `clinical:sourceEHR` is written as a triple and never reaches a key builder on
 * either transport, so in principle nothing here can move. "In principle" is
 * what a golden pin is for. A record IRI that moves is a duplicate on every pod
 * that already holds the record, invisible until someone counts, and no test
 * that compares two computed values would catch it: that test passes just as
 * happily when both have moved.
 *
 * HOW THESE VALUES WERE OBTAINED, because a golden pin copied out of the run it
 * constrains proves nothing: they are the IRIs the converters at origin/main
 * mint from these fixtures, read out of a checkout of origin/main, BEFORE any of
 * this change existed.
 */
describe('golden pins: no record IRI moves when the source axes do', () => {
  const FIXTURES = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'test-fixtures',
    'pathology',
  );

  /** `TypeLocalName IRI` for every record subject, sorted. */
  function typedSubjects(ttl: string): string[] {
    const byUri = new Map<string, string>();
    for (const t of parse(ttl)) {
      if (t.p === RDF_TYPE) byUri.set(t.s, t.o.split('#').pop() as string);
    }
    return [...byUri].map(([uri, type]) => `${type} ${uri}`).sort();
  }

  it('mints the pre-change IRIs for the FHIR half of the dual-transport pair', async () => {
    const input = readFileSync(path.join(FIXTURES, 'p01-dual-label-fhir.json'), 'utf-8');
    const result = await convert(input, 'fhir', 'cascade', 'turtle', 'p01-fhir');
    expect(typedSubjects(result.output)).toEqual([
      'ConditionRecord urn:uuid:efdbc4e8-ae76-5951-b501-116b86cd6774',
      'ImmunizationRecord urn:uuid:994b9672-c37f-5422-940d-2b23e12284a0',
      'LabResultRecord urn:uuid:b60bf2fc-5a3c-52ec-9c65-3af3bbfa56f0',
      'PatientProfile urn:uuid:5269032f-c3ed-5601-984e-9968f24a2dc2',
    ]);
  });

  it('mints the pre-change IRIs for the C-CDA half, section documents included', async () => {
    // The section ClinicalDocument nodes are the ones worth naming: their key is
    // built from the section code, the document id and the INGESTION label, and
    // the label axis is passed into the same function for a different purpose.
    // If it ever reached the key, these two are what would move.
    const input = readFileSync(path.join(FIXTURES, 'p01-dual-label-ccda.xml'), 'utf-8');
    const result = await convertCcda(input, {
      sourceSystem: 'p01-ccda',
      importedAt: '2026-01-01T00:00:00Z',
    });
    expect(typedSubjects(result.output)).toEqual([
      'ClinicalDocument urn:uuid:068d7478-b123-50f8-b0fe-e14cbc21d092',
      'ClinicalDocument urn:uuid:ac0b69f8-dc7a-5843-8093-03b09c5b7cb8',
      'ConditionRecord urn:uuid:bfac17d9-5034-5902-ac10-de00ba6d0fdf',
      'LabResultRecord urn:uuid:aa7622d6-9e51-51ca-9026-a6c6c7991cab',
      'LaboratoryReport urn:uuid:d3e74e76-7a77-5cf4-8482-4a8eb2dd5dcc',
      'PatientProfile urn:uuid:109dd41d-23e8-5151-b7d2-678555b7b35e',
    ]);
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

  it('reaches the same answer on the fast path as on the single-batch path', async () => {
    // THE TWO PATHS MUST AGREE, and this is the two-sided measurement of it.
    //
    // What this test used to pin was the DISAGREEMENT. `runReconciliation` picks
    // the `--reconcile-existing` fast path when an input is marked
    // `existingPod: true`, and that path ran a cross-batch pass that assigned
    // EVERY new record, matched or not, before the new-against-new pass could
    // seed from any of them. So the second pass and its same-source guard site
    // were unreachable, and two duplicates arriving in ONE import were never
    // compared with each other whenever the pod held anything — while the SAME
    // pair through the single-batch path merged. Measured: 3 records against 1
    // on identical inputs.
    //
    // The two passes are now one pass whose candidate list is the union of both
    // pools, so the fast path runs the single-batch algorithm restricted to
    // new-record seeds. Both halves below are kept, and they are what makes this
    // pin two-sided: the fast path merging the pair is the fix, and the
    // single-batch path still merging it is the guarantee that the fix did not
    // arrive by loosening the guard.
    const pod = `${RECON_PREFIXES}
<urn:uuid:lab-already-in-pod> a health:LabResultRecord ;
  health:testCode <http://loinc.org/rdf#2160-0> ;
  health:testName "Creatinine" ;
  health:performedDate "2031-05-20" ;
  health:resultValue "1.1" .
`;
    const alpha = labTtl('urn:uuid:lab-alpha-x', { batch: 'Household export', origin: 'org:stonebridge' });
    const beta = labTtl('urn:uuid:lab-beta-x', { batch: 'Household export', origin: 'org:larkfield' });

    // Fast path: pod content present. The batch's internal duplicate merges, and
    // the unrelated pod record (a different LOINC) passes through untouched.
    const fast = await runReconciliation([
      { content: pod, systemName: 'existing-pod', existingPod: true },
      { content: alpha, systemName: 'Household export' },
      { content: beta, systemName: 'Household export' },
    ]);
    expect(recordSubjects(parse(fast.turtle)).length).toBe(2);

    // Single-batch path: same pair, no pod content. The guard admits, they merge.
    const single = await runReconciliation([
      { content: alpha, systemName: 'Household export' },
      { content: beta, systemName: 'Household export' },
    ]);
    expect(recordSubjects(parse(single.turtle)).length).toBe(1);
  });

  it('merges a batch duplicate and a pod duplicate into ONE record, not two', async () => {
    // The case that rules out both of the smaller repairs the ordering comment
    // names. Three copies of one result: one already in the pod, two arriving in
    // one batch under three different known origins.
    //
    //   deferring assignment  -> alpha absorbs the pod copy, beta is left over: 2
    //   within-batch first    -> alpha absorbs beta, neither meets the pod copy: 2
    //
    // One pass over the union of both pools is the only arrangement that reaches
    // 1, which is why the fix is an ordering decision rather than a guard patch.
    const podCopy = labTtl('urn:uuid:lab-in-pod-y', { batch: 'Earlier import', origin: 'org:brightwater' });
    const alpha = labTtl('urn:uuid:lab-alpha-y', { batch: 'Household export', origin: 'org:stonebridge' });
    const beta = labTtl('urn:uuid:lab-beta-y', { batch: 'Household export', origin: 'org:larkfield' });

    const result = await runReconciliation([
      { content: podCopy, systemName: 'existing-pod', existingPod: true },
      { content: alpha, systemName: 'Household export' },
      { content: beta, systemName: 'Household export' },
    ]);
    expect(recordSubjects(parse(result.turtle)).length).toBe(1);
  });

  it('never matches a record against itself now that the seed is its own candidate', async () => {
    // The cost of merging the two passes into one. The seed record is now IN the
    // candidate list it walks, and `doRecordsMatch(a, a)` is a perfect match, so
    // nothing about the record's CONTENT stops it grouping with itself.
    //
    // What this pins is the OUTCOME, not one line: no phantom merge, whichever
    // clause is doing the work. That distinction is load bearing here, because
    // two clauses currently do it. `b === a` states the condition directly, and
    // `sameSourceStatement(a, a)` is unconditionally true and would reject the
    // self-pair on its own, so neither is individually mutation-visible. The
    // property is worth a test regardless: the record COUNT is unchanged either
    // way, so a regression here would show up not as a lost record but as a
    // survivor carrying `mergedFrom` pointing at itself and a report counting a
    // duplicate that does not exist.
    const pod = `${RECON_PREFIXES}
<urn:uuid:lab-already-in-pod> a health:LabResultRecord ;
  health:testCode <http://loinc.org/rdf#2160-0> ;
  health:testName "Creatinine" ;
  health:performedDate "2031-05-20" ;
  health:resultValue "1.1" .
`;
    const lone = labTtl('urn:uuid:lab-lone', { batch: 'Household export', origin: 'org:stonebridge' });
    const result = await runReconciliation([
      { content: pod, systemName: 'existing-pod', existingPod: true },
      { content: lone, systemName: 'Household export' },
    ]);

    expect(recordSubjects(parse(result.turtle)).length).toBe(2);
    // Nothing merged, so nothing may CLAIM to have merged.
    expect(result.report.summary.exactDuplicatesRemoved).toBe(0);
    expect(result.report.summary.nearDuplicatesMerged).toBe(0);
    expect(result.report.transformations).toEqual([]);
    const triples = parse(result.turtle);
    expect(values(triples, 'https://ns.cascadeprotocol.org/core/v1#mergedFrom')).toEqual([]);
    expect(values(triples, 'https://ns.cascadeprotocol.org/core/v1#reconciliationStatus')).toEqual([
      'canonical',
    ]);
  });

  it('still never compares two records that were both already in the pod', async () => {
    // The restriction the single pass deliberately KEEPS. Only new records seed
    // a group, so an import cannot silently reconcile pod content against itself
    // as a side effect of importing an unrelated file. `pod reconcile` is where
    // that mutation is asked for, reported first, and applied on purpose.
    const podA = labTtl('urn:uuid:lab-pod-a', { batch: 'Earlier import', origin: 'org:stonebridge' });
    const podB = labTtl('urn:uuid:lab-pod-b', { batch: 'Earlier import', origin: 'org:larkfield' });
    const unrelated = `${RECON_PREFIXES}
<urn:uuid:lab-unrelated> a health:LabResultRecord ;
  cascade:sourceSystem "New import" ;
  health:testCode <http://loinc.org/rdf#2160-0> ;
  health:testName "Creatinine" ;
  health:performedDate "2031-05-20" ;
  health:resultValue "1.1" .
`;
    const result = await runReconciliation([
      { content: podA, systemName: 'existing-pod', existingPod: true },
      { content: podB, systemName: 'existing-pod', existingPod: true },
      { content: unrelated, systemName: 'New import' },
    ]);
    // Two pod duplicates + the unrelated new record. The pod pair is untouched.
    expect(recordSubjects(parse(result.turtle)).length).toBe(3);
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
