/**
 * Tests for the CAP applier (TASK-4.5).
 *
 * Covers acceptance criteria:
 *   - Successful application writes inserted triples and creates one
 *     AdvisoryApplicationActivity record per match.
 *   - Activity captures advisory ID, applied-at time, matched record IRI,
 *     and an inserted-triples count.
 *   - BRCA2 reclassification example produces a NEW VariantInterpretation
 *     with prov:wasRevisionOf linkage to the prior — this is the M4.2
 *     manual verification milestone (D-N6).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store, DataFactory } from 'n3';
import { parseCap } from '../src/lib/advisory/ldpatch-parser.js';
import { evaluateSelector } from '../src/lib/advisory/selector.js';
import { applyCap } from '../src/lib/advisory/applier.js';

const { namedNode, literal, quad } = DataFactory;

const EXAMPLES_DIR = path.resolve(
  os.homedir(),
  'Development/cascadeprotocol.org/drafts/advisory-v1',
);

const CA_ID = 'https://ns.cascadeprotocol.org/genomics/v1#caId';
const HGNC_ID = 'https://ns.cascadeprotocol.org/genomics/v1#hgncId';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const VARIANT = 'https://ns.cascadeprotocol.org/genomics/v1#Variant';
const VARIANT_INTERPRETATION =
  'https://ns.cascadeprotocol.org/genomics/v1#VariantInterpretation';
const PROV_WAS_REVISION_OF = 'http://www.w3.org/ns/prov#wasRevisionOf';
const PROV_USED = 'http://www.w3.org/ns/prov#used';
const PROV_AT_TIME = 'http://www.w3.org/ns/prov#atTime';
const ADVISORY_APPLICATION_ACTIVITY =
  'https://ns.cascadeprotocol.org/core/v1#AdvisoryApplicationActivity';
const APPLIED_TRIPLES_COUNT =
  'https://ns.cascadeprotocol.org/core/v1#appliedTriplesCount';

describe('CAP applier — happy path', () => {
  it('applies the BRCA2 reclassification advisory and creates one activity per match', () => {
    const src = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch'),
      'utf8',
    );
    const { ast } = parseCap(src);
    expect(ast).not.toBeNull();

    const pod = new Store();
    pod.addQuad(quad(namedNode('urn:pod:variant:1'), namedNode(RDF_TYPE), namedNode(VARIANT)));
    pod.addQuad(quad(namedNode('urn:pod:variant:1'), namedNode(CA_ID), literal('CA000123')));

    const bindings = evaluateSelector(ast!, pod);
    expect(bindings.length).toBe(1);

    const fixedNow = new Date('2026-05-04T12:00:00Z');
    let nextId = 1;
    const result = applyCap(
      ast!,
      bindings,
      pod,
      'urn:advisory:clingen-hbop-2026-05-04-001',
      {
        now: fixedNow,
        mintActivityIri: () => `urn:test:activity:${nextId++}`,
      },
    );

    expect(result.matchesApplied).toBe(1);
    expect(result.activityIris).toEqual(['urn:test:activity:1']);
    expect(result.matchedRecordIris).toEqual(['urn:pod:variant:1']);

    // Activity record present in the pod
    const activityType = pod.getQuads(
      namedNode('urn:test:activity:1'),
      namedNode(RDF_TYPE),
      namedNode(ADVISORY_APPLICATION_ACTIVITY),
      null,
    );
    expect(activityType.length).toBe(1);

    // prov:used links: advisory IRI + matched record IRI
    const used = pod.getQuads(namedNode('urn:test:activity:1'), namedNode(PROV_USED), null, null);
    const usedValues = used.map((q) => q.object.value).sort();
    expect(usedValues).toContain('urn:advisory:clingen-hbop-2026-05-04-001');
    expect(usedValues).toContain('urn:pod:variant:1');

    // prov:atTime stamped with the override
    const atTime = pod.getQuads(
      namedNode('urn:test:activity:1'),
      namedNode(PROV_AT_TIME),
      null,
      null,
    );
    expect(atTime.length).toBe(1);
    expect(atTime[0]!.object.value).toBe('2026-05-04T12:00:00.000Z');

    // appliedTriplesCount stamped with the patch-emitted triple count (11 from the BRCA2 example)
    const counts = pod.getQuads(
      namedNode('urn:test:activity:1'),
      namedNode(APPLIED_TRIPLES_COUNT),
      null,
      null,
    );
    expect(counts.length).toBe(1);
    expect(counts[0]!.object.value).toBe('11');
  });

  it('M4.2 verification: BRCA2 advisory produces VariantInterpretation with prov:wasRevisionOf linkage', () => {
    const src = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch'),
      'utf8',
    );
    const { ast } = parseCap(src);

    const pod = new Store();
    pod.addQuad(quad(namedNode('urn:pod:variant:1'), namedNode(RDF_TYPE), namedNode(VARIANT)));
    pod.addQuad(quad(namedNode('urn:pod:variant:1'), namedNode(CA_ID), literal('CA000123')));

    const bindings = evaluateSelector(ast!, pod);
    applyCap(ast!, bindings, pod, 'urn:advisory:clingen-hbop-2026-05-04-001');

    // Find the new VariantInterpretation
    const interps = pod.getQuads(null, namedNode(RDF_TYPE), namedNode(VARIANT_INTERPRETATION), null);
    expect(interps.length).toBe(1);
    const interpIri = interps[0]!.subject.value;
    expect(interpIri).toBe('urn:advisory:clingen-hbop-2026-05-04-001/interp');

    // Linked to the prior via prov:wasRevisionOf  →  ?v (the matched variant)
    const revisionOf = pod.getQuads(
      namedNode(interpIri),
      namedNode(PROV_WAS_REVISION_OF),
      null,
      null,
    );
    expect(revisionOf.length).toBe(1);
    expect(revisionOf[0]!.object.value).toBe('urn:pod:variant:1');

    // The prior variant is NOT modified or removed (monotonic insert per C1)
    const variantStillThere = pod.getQuads(
      namedNode('urn:pod:variant:1'),
      namedNode(RDF_TYPE),
      namedNode(VARIANT),
      null,
    );
    expect(variantStillThere.length).toBe(1);
  });
});

describe('CAP applier — multiple bindings', () => {
  it('creates one activity per binding when the selector matches multiple records', () => {
    const src = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-cpic-cyp2c19-warfarin.ldpatch'),
      'utf8',
    );
    const { ast } = parseCap(src);

    const pod = new Store();
    for (const i of [1, 2, 3]) {
      pod.addQuad(
        quad(
          namedNode(`urn:pod:gene:${i}`),
          namedNode(HGNC_ID),
          literal('HGNC:2621'),
        ),
      );
    }
    const bindings = evaluateSelector(ast!, pod);
    expect(bindings.length).toBe(3);

    let counter = 0;
    const result = applyCap(ast!, bindings, pod, 'urn:advisory:cpic-warfarin', {
      mintActivityIri: () => `urn:test:activity:${++counter}`,
    });
    expect(result.activityIris.length).toBe(3);
    expect(result.activityIris).toEqual([
      'urn:test:activity:1',
      'urn:test:activity:2',
      'urn:test:activity:3',
    ]);
    expect(new Set(result.matchedRecordIris)).toEqual(
      new Set(['urn:pod:gene:1', 'urn:pod:gene:2', 'urn:pod:gene:3']),
    );

    // Each binding got a distinct DosingGuidance — but all share the same
    // root IRI from the patch (`<urn:advisory:.../guidance>`). That's
    // expected: the patch's literal IRIs are global, so subsequent applications
    // overwrite the same subject. This is the right semantics for advisories
    // that target a static guidance node — the prov chain via the activity
    // record disambiguates which match produced which insertion.
    // We don't assert here on the exact subject; we verify activity count.
    const activities = pod.getQuads(
      null,
      namedNode(RDF_TYPE),
      namedNode(ADVISORY_APPLICATION_ACTIVITY),
      null,
    );
    expect(activities.length).toBe(3);
  });
});

describe('CAP applier — variable substitution', () => {
  it('replaces ?var with the bound IRI in Add triples', () => {
    const cap = `
@prefix advisory: <https://ns.cascadeprotocol.org/advisory/v1#> .
@prefix genomics: <https://ns.cascadeprotocol.org/genomics/v1#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<> a advisory:CascadeAdvisoryPatch ;
   advisory:profileVersion "0.1" ;
   advisory:advisoryClass advisory:VariantReclassification ;
   advisory:issuer <https://example.org/issuer> ;
   advisory:issuedAt "2026-01-01T00:00:00Z"^^xsd:dateTime ;
   advisory:humanSummary "Summary." .

Bind ?v <https://example.org/binding>
   ?v genomics:caId "CA1" .

Add {
  <urn:patch:annotation> genomics:annotates ?v ;
                          genomics:note "test" .
} .
`;
    const { ast } = parseCap(cap);
    const pod = new Store();
    pod.addQuad(quad(namedNode('urn:pod:v1'), namedNode(CA_ID), literal('CA1')));
    const bindings = evaluateSelector(ast!, pod);
    applyCap(ast!, bindings, pod, 'urn:test:advisory');

    const annotates = pod.getQuads(
      namedNode('urn:patch:annotation'),
      namedNode('https://ns.cascadeprotocol.org/genomics/v1#annotates'),
      null,
      null,
    );
    expect(annotates.length).toBe(1);
    expect(annotates[0]!.object.value).toBe('urn:pod:v1');
  });
});

describe('CAP applier — generated-by linkage', () => {
  it('adds prov:wasGeneratedBy from new root subjects to the activity', () => {
    const src = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch'),
      'utf8',
    );
    const { ast } = parseCap(src);
    const pod = new Store();
    pod.addQuad(quad(namedNode('urn:pod:v1'), namedNode(CA_ID), literal('CA000123')));
    const bindings = evaluateSelector(ast!, pod);
    const result = applyCap(ast!, bindings, pod, 'urn:adv:test', {
      mintActivityIri: () => 'urn:test:activity:42',
    });
    const activityIri = result.activityIris[0]!;

    // The new VariantInterpretation should be linked to the activity.
    const generatedBy = pod.getQuads(
      namedNode('urn:advisory:clingen-hbop-2026-05-04-001/interp'),
      namedNode('http://www.w3.org/ns/prov#wasGeneratedBy'),
      namedNode(activityIri),
      null,
    );
    expect(generatedBy.length).toBe(1);
  });

  it('suppresses generated-by links when suppressActivityLinks is set (dry-run mode)', () => {
    const src = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch'),
      'utf8',
    );
    const { ast } = parseCap(src);
    const pod = new Store();
    pod.addQuad(quad(namedNode('urn:pod:v1'), namedNode(CA_ID), literal('CA000123')));
    const bindings = evaluateSelector(ast!, pod);
    const result = applyCap(ast!, bindings, pod, 'urn:adv:test', {
      mintActivityIri: () => 'urn:test:activity:42',
      suppressActivityLinks: true,
    });
    const generatedByActivity = pod.getQuads(
      null,
      namedNode('http://www.w3.org/ns/prov#wasGeneratedBy'),
      namedNode(result.activityIris[0]!),
      null,
    );
    expect(generatedByActivity.length).toBe(0);
  });
});

describe('CAP applier — empty bindings', () => {
  it('makes no changes when there are zero bindings', () => {
    const src = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch'),
      'utf8',
    );
    const { ast } = parseCap(src);
    const pod = new Store();
    const before = pod.size;
    const result = applyCap(ast!, [], pod, 'urn:adv:test');
    expect(result.matchesApplied).toBe(0);
    expect(result.insertedQuads.length).toBe(0);
    expect(pod.size).toBe(before);
  });
});
